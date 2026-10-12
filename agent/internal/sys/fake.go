package sys

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"magnemite/agent/internal/proto"
)

// Fake stands in for an Android box so the whole install pipeline — including
// the pm session dance and the uninstall fallback — can be exercised on a
// laptop. scripts/fake-fleet.sh runs a few hundred of these against the hub.
//
// Failure injection, all via environment variables:
//
//	MAGNEMITE_FAKE_COMMIT_ERROR       text install-commit fails with
//	MAGNEMITE_FAKE_COMMIT_ERROR_ONCE  only fail the first commit, so the
//	                                  uninstall fallback gets exercised
//	MAGNEMITE_FAKE_FREE_BYTES         override free space, to trip the gate
//	MAGNEMITE_FAKE_INSTALL_MS         how long a commit pretends to take
//	MAGNEMITE_FAKE_FOREGROUND         package the box claims is focused;
//	                                  unset means the launcher, which is what
//	                                  the "pogo not in focus" rule fires on
//	MAGNEMITE_FAKE_ANR                package the box claims is not responding
type Fake struct {
	mu         sync.Mutex
	serial     string
	statePath  string
	packages   map[string]proto.PackageInfo
	settings   map[string]string
	sessions   map[string]bool
	nextID     int
	pending    string
	commitFail int
	started    time.Time
}

type fakeState struct {
	Packages map[string]proto.PackageInfo `json:"packages"`
}

func NewFake(serial, statePath string) *Fake {
	f := &Fake{
		serial:    serial,
		statePath: statePath,
		packages:  map[string]proto.PackageInfo{},
		settings:  map[string]string{},
		sessions:  map[string]bool{},
		nextID:    100000,
		started:   time.Now(),
	}
	f.load()
	return f
}

// SetPendingVersion tells the fake what an install-commit should end up
// reporting. Only the fake needs this; on a real box the version comes out of
// the APKs themselves.
func (f *Fake) SetPendingVersion(v string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pending = v
}

func (f *Fake) load() {
	if f.statePath == "" {
		return
	}
	data, err := os.ReadFile(f.statePath)
	if err != nil {
		return
	}
	var st fakeState
	if json.Unmarshal(data, &st) == nil && st.Packages != nil {
		f.packages = st.Packages
	}
}

func (f *Fake) save() {
	if f.statePath == "" {
		return
	}
	data, err := json.MarshalIndent(fakeState{Packages: f.packages}, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(f.statePath, data, 0o644)
}

// WriteFileAtomic writes where a real box would, except that "/data/local/tmp/
// aegis_config.json" is not a path a laptop has. Everything lands in a directory
// named for the box, with the separators flattened into the filename, so a
// config pushed to fake-007 shows up as
// `.dev/fleet/fake-007.files/data_local_tmp_aegis_config.json` and can be read
// back to check the placeholders were substituted.
//
// The whole path is still exercised — the mkdir, the temp file, the rename, the
// read-back — which is the point of the fake at all.
func (f *Fake) WriteFileAtomic(path string, content []byte, mode os.FileMode) (string, error) {
	local := f.localPath(path)
	if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
		return "", err
	}
	// Its own name per write, for the reason the real one has: an install and a
	// dashboard push can write the same path at the same time.
	tmp := tempPathFor(local)
	if err := os.WriteFile(tmp, content, mode); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, local); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return sha256File(local)
}

// FakeFilesDir is where a fake box's written files land, given its state path.
// Exported so a test can look for them without repeating the rule.
func FakeFilesDir(statePath, serial string) string {
	if statePath == "" {
		return filepath.Join(os.TempDir(), "magnemite-fake", serial+".files")
	}
	// Named for the box rather than derived from the state file, whose name is
	// "<config>.json.state" — trimming extensions off that produces something
	// nobody would guess when they go looking for the file.
	return filepath.Join(filepath.Dir(statePath), serial+".files")
}

func (f *Fake) localPath(path string) string {
	flat := strings.Trim(strings.ReplaceAll(filepath.ToSlash(path), "/", "_"), "_")
	return filepath.Join(FakeFilesDir(f.statePath, f.serial), flat)
}

func (f *Fake) Prop(_ context.Context, name string) string {
	switch name {
	case "ro.serialno", "ro.boot.serialno":
		return f.serial
	case "ro.product.manufacturer":
		return "Magnemite"
	case "ro.product.model":
		return "FakeBox"
	case "ro.build.version.release":
		return "11"
	case "ro.build.version.sdk":
		return "30"
	case "ro.product.cpu.abi":
		return "arm64-v8a"
	case "ro.sf.lcd_density":
		return "320"
	case "net.dns1":
		return ""
	}
	return ""
}

func (f *Fake) Shell(ctx context.Context, script string) (string, error) {
	// The monitor probes are the one thing worth answering rather than
	// swallowing: a fake fleet is how the escalation ladder gets exercised at
	// all, and a box that always reports healthy can never demonstrate that a
	// rule restarts anything. Everything else — hooks included — stays
	// recorded and unrun, which is the point of fake mode.
	switch {
	case strings.Contains(script, "mFocusedApp"):
		if pkg := os.Getenv("MAGNEMITE_FAKE_FOREGROUND"); pkg != "" {
			return fmt.Sprintf("mFocusedApp=ActivityRecord{1a2b3c u0 %s/.MainActivity t42}", pkg), nil
		}
		return "mFocusedApp=null", nil

	case strings.Contains(script, "Application Not Responding"):
		if pkg := os.Getenv("MAGNEMITE_FAKE_ANR"); pkg != "" {
			return "Application Not Responding: " + pkg, nil
		}
		return "", nil

	case strings.Contains(script, "MAGNEMITE_FAKE_SHELL_FAIL"):
		// A probe an operator can deliberately break from the dashboard, by
		// pointing a shell check at this string.
		return "", fmt.Errorf("fake shell failure")
	}
	return "", nil
}

func (f *Fake) Exec(ctx context.Context, name string, args ...string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	switch name {
	case "pm":
		return f.pm(ctx, args)
	case "dumpsys":
		if len(args) >= 2 && args[0] == "package" {
			return f.dumpsys(args[1]), nil
		}
	case "getprop":
		if len(args) == 1 {
			return f.Prop(ctx, args[0]), nil
		}
	case "settings":
		return f.settingsCmd(args)
	case "sh":
		return "", nil
	}
	return "", nil
}

func (f *Fake) pm(ctx context.Context, args []string) (string, error) {
	if len(args) == 0 {
		return "", nil
	}
	switch args[0] {
	case "install-create":
		f.nextID++
		id := strconv.Itoa(f.nextID)
		f.sessions[id] = true
		return fmt.Sprintf("Success: created install session [%s]", id), nil

	case "install-write":
		return "Success: streamed", nil

	case "install-commit":
		if delay := os.Getenv("MAGNEMITE_FAKE_INSTALL_MS"); delay != "" {
			if ms, err := strconv.Atoi(delay); err == nil {
				f.mu.Unlock()
				select {
				case <-time.After(time.Duration(ms) * time.Millisecond):
				case <-ctx.Done():
				}
				f.mu.Lock()
			}
		}

		if msg := os.Getenv("MAGNEMITE_FAKE_COMMIT_ERROR"); msg != "" {
			once := os.Getenv("MAGNEMITE_FAKE_COMMIT_ERROR_ONCE") != ""
			if !once || f.commitFail == 0 {
				f.commitFail++
				return "", fmt.Errorf("pm install-commit: Failure [%s]", msg)
			}
		}

		pkg := "com.nianticlabs.pokemongo"
		f.packages[pkg] = proto.PackageInfo{
			PackageName: pkg,
			VersionName: f.pending,
			VersionCode: strconv.FormatInt(time.Now().Unix(), 10),
			Installed:   true,
		}
		f.save()
		return "Success", nil

	case "uninstall":
		pkg := args[len(args)-1]
		delete(f.packages, pkg)
		f.save()
		return "Success", nil

	case "install-abandon":
		return "Success", nil
	}
	return "", nil
}

func (f *Fake) dumpsys(pkg string) string {
	info, ok := f.packages[pkg]
	if !ok {
		return ""
	}
	return fmt.Sprintf(
		"Packages:\n  Package [%s] (deadbeef):\n    versionCode=%s minSdk=30 targetSdk=33\n    versionName=%s\n",
		pkg, info.VersionCode, info.VersionName,
	)
}

func (f *Fake) settingsCmd(args []string) (string, error) {
	if len(args) >= 3 && args[0] == "get" {
		return f.settings[args[1]+"/"+args[2]], nil
	}
	if len(args) >= 4 && args[0] == "put" {
		f.settings[args[1]+"/"+args[2]] = args[3]
		return "", nil
	}
	return "", nil
}

func (f *Fake) Disk(string) (uint64, uint64, error) {
	if v := os.Getenv("MAGNEMITE_FAKE_FREE_BYTES"); v != "" {
		free, err := strconv.ParseUint(v, 10, 64)
		if err == nil {
			return free, 8 * 1024 * 1024 * 1024, nil
		}
	}
	return 6 * 1024 * 1024 * 1024, 8 * 1024 * 1024 * 1024, nil
}

// A fake box has no system_server to lose, so it is always ready — except
// when a test says otherwise, which is how the wait itself gets exercised
// without hardware.
func (f *Fake) SystemServicesUp(context.Context) bool {
	return os.Getenv("MAGNEMITE_FAKE_SYSTEM_DOWN") == ""
}

func (f *Fake) UptimeSeconds() int64 {
	return int64(time.Since(f.started).Seconds())
}

func (f *Fake) PackageInfo(_ context.Context, pkg string) (proto.PackageInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if info, ok := f.packages[pkg]; ok {
		return info, nil
	}
	return proto.PackageInfo{PackageName: pkg, Installed: false}, nil
}

// The fake fleet is what the load test runs against, so these
// wobble a little rather than returning a constant: a dashboard that only
// ever shows 0.00 load hides the bugs this is meant to catch.
func (f *Fake) LoadAvg() (float64, float64, float64) {
	base := float64(time.Since(f.started).Seconds())
	one := 0.4 + math.Abs(math.Sin(base/60))*1.2
	return round2(one), round2(one * 0.9), round2(one * 0.8)
}

func (f *Fake) Memory() (uint64, uint64) {
	const total = 2 * 1024 * 1024 * 1024
	free := uint64(float64(total) * (0.25 + math.Abs(math.Cos(float64(time.Since(f.started).Seconds())/90))*0.2))
	return total, free
}

func (f *Fake) CPUCount() int { return 4 }

// Tracks the fake load average, so the CPU chart and the load chart have the
// same shape and a wrongly-scaled axis is obvious during a load test -- the
// same reason Temperatures() below follows it.
//
// Percent of a single core, so a 4-core fake box reads up to ~400 and the
// dashboard's "divide by cpuCount" path gets exercised rather than being
// assumed. Deliberately never nil: a fake box always has two readings, and the
// nil-until-a-rate-exists path is the real agent's to prove.
func (f *Fake) CPUPercent() *float64 {
	// A load average of 1.0 is one core busy, which is 100 in this convention.
	one, _, _ := f.LoadAvg()
	percent := round2(one * 100)
	return &percent
}

// Half the fake box's RAM, mostly free. A fake box reports swap at all so the
// host-shaped fields have something to draw; the interesting case -- a machine
// with none, which answers a genuine zero -- is reachable with
// MAGNEMITE_FAKE_NO_SWAP.
func (f *Fake) Swap() (uint64, uint64, bool) {
	if os.Getenv("MAGNEMITE_FAKE_NO_SWAP") != "" {
		return 0, 0, true
	}
	const total = 1 * 1024 * 1024 * 1024
	free := uint64(float64(total) * (0.6 + math.Abs(math.Sin(float64(time.Since(f.started).Seconds())/120))*0.3))
	return total, free, true
}

// A warm box that tracks its own load, so the temperature chart in the
// dashboard shows something with the same shape as the CPU one — which is what
// makes a wrongly-scaled axis obvious during a load test.
func (f *Fake) Temperatures() (float64, float64) {
	one, _, _ := f.LoadAvg()
	return round2(42 + one*6), round2(31 + one*2)
}

// Per-app usage for the fake fleet: one busy app and the rest idling, so the
// per-package charts have a clear shape to check rather than N identical
// lines. Deterministic per package name, so a given box's series stays put
// across beats instead of jittering at random.
func (f *Fake) ProcessStats(packages []string) []proto.ProcessStats {
	if len(packages) == 0 {
		return nil
	}
	seconds := time.Since(f.started).Seconds()
	stats := make([]proto.ProcessStats, 0, len(packages))

	for i, pkg := range packages {
		// The first tracked package is the scanner: busy, and growing its heap
		// the way a long-running app does.
		phase := float64(i) * 1.7
		weight := 1.0 / float64(i+1)
		count := 1 + i%2
		stats = append(stats, proto.ProcessStats{
			PackageName:  pkg,
			CPUPercent:   round2((25 + math.Abs(math.Sin(seconds/45+phase))*55) * weight),
			RSSBytes:     uint64((180 + math.Abs(math.Cos(seconds/120+phase))*140) * weight * 1024 * 1024),
			ProcessCount: &count,
		})
	}
	return stats
}

func (f *Fake) ThirdPartyPackages(_ context.Context) ([]proto.PackageInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	packages := make([]proto.PackageInfo, 0, len(f.packages)+2)
	for _, info := range f.packages {
		if info.Installed {
			packages = append(packages, proto.PackageInfo{
				PackageName: info.PackageName,
				VersionCode: info.VersionCode,
				Installed:   true,
			})
		}
	}
	// A couple of extras so the inventory is visibly more than the tracked app.
	packages = append(packages,
		proto.PackageInfo{PackageName: "com.unownhash.dragonite", VersionCode: "42", Installed: true},
		proto.PackageInfo{PackageName: "com.android.tv.launcher", VersionCode: "7", Installed: true},
	)
	return packages, nil
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

func (f *Fake) DeviceInfo(ctx context.Context) proto.DeviceInfo {
	return proto.DeviceInfo{
		Serial:         f.serial,
		Manufacturer:   "Magnemite",
		Model:          "FakeBox",
		AndroidVersion: "11",
		SdkInt:         30,
		Abi:            "arm64-v8a",
		Density:        320,
		LocalIp:        LocalIP(),
	}
}

// LogcatStream fabricates a log that keeps writing, so the live panel and the
// batching around it can be exercised without an Android box.
func (f *Fake) LogcatStream(ctx context.Context) (io.ReadCloser, error) {
	return f.fakeStream(ctx, "logcat")
}

// FileStream pretends the file exists and writes to it. A fake fleet has no
// /data/local/tmp/aegis.log, and failing here would only make the panel
// untestable.
func (f *Fake) FileStream(ctx context.Context, path string) (io.ReadCloser, error) {
	return f.fakeStream(ctx, path)
}

func (f *Fake) fakeStream(ctx context.Context, source string) (io.ReadCloser, error) {
	reader, writer := io.Pipe()

	go func() {
		defer writer.Close()
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()

		for i := 0; ; i++ {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				line := fmt.Sprintf(
					"%s I/magnemite-fake( 1234): [%s] synthetic log line %d from %s\n",
					now.Format("01-02 15:04:05.000"), source, i, f.serial,
				)
				if _, err := io.WriteString(writer, line); err != nil {
					return
				}
			}
		}
	}()

	return reader, nil
}

var _ System = (*Fake)(nil)
var _ System = (*Android)(nil)
