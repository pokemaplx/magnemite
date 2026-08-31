// Package sys wraps everything the agent needs from the Android box it runs
// on: system properties, root shell, storage and package state.
//
// Every call goes through the System interface so the whole install pipeline
// can be exercised on a laptop against the Fake implementation — which is how
// fleet-scale load tests run without the hardware.
package sys

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"magnemite/agent/internal/proto"
)

type System interface {
	// Prop reads an Android system property. Empty string when unset.
	Prop(ctx context.Context, name string) string
	// Exec runs a binary directly.
	Exec(ctx context.Context, name string, args ...string) (string, error)
	// Shell runs a script through sh -c.
	Shell(ctx context.Context, script string) (string, error)
	// Disk reports free and total bytes on the filesystem holding path.
	Disk(path string) (free uint64, total uint64, err error)
	// WriteFileAtomic puts content at path through a temp file and a rename, so
	// a scanner reading the file while it is replaced sees the old bytes or the
	// new ones and never a half-written middle.
	//
	// It returns the sha256 of what is on disk once the rename is done, read
	// back rather than computed from the content it was handed: the hub uses it
	// to prove what the box has, and hashing the input would only prove what
	// the hub sent.
	WriteFileAtomic(path string, content []byte, mode os.FileMode) (sha256 string, err error)
	// SystemServicesUp reports whether the binder services an install needs
	// are registered. False while system_server is restarting — which on
	// these boxes is not the same thing as the box being down, because the
	// kernel and this agent both live straight through it.
	SystemServicesUp(ctx context.Context) bool
	UptimeSeconds() int64
	// LoadAvg is the 1/5/15-minute run queue average out of /proc/loadavg.
	LoadAvg() (one float64, five float64, fifteen float64)
	// Memory reports total and available bytes out of /proc/meminfo.
	Memory() (total uint64, available uint64)
	CPUCount() int
	// Temperatures reports degrees Celsius for the SoC and the battery. Zero
	// means the box exposes no such sensor, which is common enough on TV
	// hardware that it is a normal answer rather than an error.
	Temperatures() (cpuC float64, batteryC float64)
	// ProcessStats reports what each named package is currently costing, summed
	// over its processes. CPU is a rate, so it needs two readings: the first
	// call for a package establishes the baseline and reports no CPU figure.
	ProcessStats(packages []string) []proto.ProcessStats
	PackageInfo(ctx context.Context, pkg string) (proto.PackageInfo, error)
	// ThirdPartyPackages lists everything installed that did not ship with the
	// ROM. One `pm` call, no dumpsys per package — see Metrics for why.
	ThirdPartyPackages(ctx context.Context) ([]proto.PackageInfo, error)
	DeviceInfo(ctx context.Context) proto.DeviceInfo
	// LogcatStream starts logcat and hands back its output as it is written.
	// Exec is no good here: it waits for the process to end, and a live logcat
	// never does. Cancelling ctx, or closing the reader, kills the process.
	LogcatStream(ctx context.Context) (io.ReadCloser, error)
	// FileStream follows a file the same way, for the logs an app writes
	// itself rather than sending to logcat.
	FileStream(ctx context.Context, path string) (io.ReadCloser, error)
}

// Android is the real implementation. The agent is started as root — by the
// Magisk service.sh on a box, by an init service inside a Redroid container —
// so it never needs to shell out to su.
type Android struct {
	// Reported instead of ro.serialno when set. See config.Config.Serial.
	serialOverride string
	// CPU time is a counter, not a gauge: a percentage only exists between two
	// readings. These carry the previous one from beat to beat.
	cpuMu   sync.Mutex
	lastCPU map[string]cpuReading
	// Resolved package -> pids, kept so the common case skips the /proc walk.
	// Validated against each pid's own cmdline before use, because pids are
	// recycled and an app that was killed and restarted gets a new one.
	pidCache map[string][]int
}

type cpuReading struct {
	// Sum of utime+stime across the package's processes, in clock ticks.
	ticks uint64
	at    time.Time
}

func NewAndroid(serialOverride string) *Android {
	return &Android{serialOverride: serialOverride}
}

func (a *Android) Exec(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	out, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(out))
	if err != nil {
		return text, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, text)
	}
	return text, nil
}

func (a *Android) Shell(ctx context.Context, script string) (string, error) {
	return a.Exec(ctx, "sh", "-c", script)
}

func (a *Android) WriteFileAtomic(path string, content []byte, mode os.FileMode) (string, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	// Same shape as the agent's own config save: a box losing power mid-write
	// must never come back with a truncated file.
	//
	// The pid and a counter are in the name because two writes of the same
	// path do overlap: an install of a group's MITM writes its config from the
	// job goroutine while a dashboard push writes it from the socket handler.
	// Sharing one `.tmp` meant both truncating and filling the same file, and
	// what got renamed into place could be a splice of the two — the very
	// half-written file this function exists to prevent, published atomically.
	tmp := tempPathFor(path)
	if err := os.WriteFile(tmp, content, mode); err != nil {
		return "", err
	}
	// WriteFile only applies mode when it creates the file, and a leftover tmp
	// from a killed write would keep its old one.
	if err := os.Chmod(tmp, mode); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return sha256File(path)
}

// Makes each in-flight temp file's name its own. Package-level so the Fake
// shares it — the fake fleet writes configs from the same two goroutines.
var tmpCounter uint64

func tempPathFor(path string) string {
	return fmt.Sprintf("%s.tmp.%d.%d", path, os.Getpid(), atomic.AddUint64(&tmpCounter, 1))
}

func sha256File(path string) (string, error) {
	written, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(written)
	return hex.EncodeToString(sum[:]), nil
}

// The two services every install touches: `pm` talks to one and the hooks'
// `am` talks to the other. Both live in system_server, so either one missing
// means the same thing.
var installServices = []string{"package", "activity"}

// SystemServicesUp asks servicemanager directly rather than reading
// sys.boot_completed.
//
// A runtime restart — system_server killed, zygote respawning it — leaves the
// kernel, the property that says booting finished, and this agent all
// untouched, so the property can say 1 while `pm` still has nothing to talk
// to. What matters is whether the binder service is registered, which is the
// one question `service check` answers.
func (a *Android) SystemServicesUp(ctx context.Context) bool {
	for _, name := range installServices {
		out, err := a.Exec(ctx, "service", "check", name)
		// "Service package: found" when it is up, "not found" when it is not,
		// so the space matters: `Contains(out, "found")` matches both.
		if err != nil || !strings.Contains(out, ": found") {
			return false
		}
	}
	return true
}

func (a *Android) LogcatStream(ctx context.Context) (io.ReadCloser, error) {
	// -T 200, not a plain follow: logcat with no bound dumps the entire ring
	// buffer first, which is tens of thousands of lines arriving as fast as
	// the socket takes them. Two hundred is enough to see what just happened.
	return a.stream(ctx, "exec logcat -v time -T 200 2>&1")
}

// FileStream follows a file the way `tail -F` is supposed to.
//
// Not actually `tail -F`: that is toybox on these boxes, its follow support
// varies by ROM, and when it decides not to follow it still prints the tail
// first — which looks exactly like a working stream that then goes quiet. Done
// here, the polling loop is ours and behaves the same everywhere.
func (a *Android) FileStream(ctx context.Context, path string) (io.ReadCloser, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}

	offset, err := tailOffset(file, followTailLines)
	if err != nil {
		file.Close()
		return nil, err
	}

	reader, writer := io.Pipe()
	go followFile(ctx, file, path, offset, writer)
	return reader, nil
}

const (
	// Lines of context when a follow starts, matching logcat's -T.
	followTailLines = 200
	// How long to wait for more, when the log is busy and when it is not.
	//
	// A log being written to is checked often, so lines land in the panel
	// while they still feel live; one that has gone quiet backs off, because
	// waking four times a second to find nothing is the only thing polling
	// could plausibly waste. Either way it is one read on an open handle.
	followBusyInterval = 250 * time.Millisecond
	followIdleInterval = time.Second
	// How long a log counts as busy after its last line.
	followBusyFor = 5 * time.Second
)

// tailOffset finds where the last `lines` lines start, reading backwards in
// chunks so a 200 MB log does not become 200 MB of memory.
func tailOffset(file *os.File, lines int) (int64, error) {
	stat, err := file.Stat()
	if err != nil {
		return 0, err
	}

	const chunk = 8 * 1024
	end := stat.Size()
	buf := make([]byte, chunk)
	newlines := 0

	for pos := end; pos > 0; {
		size := int64(chunk)
		if pos < size {
			size = pos
		}
		pos -= size

		if _, err := file.ReadAt(buf[:size], pos); err != nil && err != io.EOF {
			return 0, err
		}
		for i := int(size) - 1; i >= 0; i-- {
			if buf[i] != '\n' {
				continue
			}
			newlines++
			// The newline *before* the first line we want to show.
			if newlines > lines {
				return pos + int64(i) + 1, nil
			}
		}
	}
	// Fewer lines in the file than asked for: start at the beginning.
	return 0, nil
}

// followFile reads to EOF, waits, and reads again — starting over when the
// file is rotated, truncated or rewritten, which are the three ways a log
// stops being the file we opened.
func followFile(ctx context.Context, file *os.File, path string, offset int64, writer *io.PipeWriter) {
	defer writer.Close()
	defer file.Close()

	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		writer.CloseWithError(err)
		return
	}
	head := headPrint(file, headPrintBytes)
	var checkedAt time.Time

	// reopenIfStale starts the file over when it is no longer the one we have
	// been reading. Three ways that happens:
	//
	//   shorter than where we are   truncated
	//   a different inode           rotated away and recreated
	//   a different opening         truncated *and* rewritten, which the size
	//                               alone misses whenever the new content is
	//                               longer than our position
	//
	// Only as many bytes as were captured are compared: appending never
	// changes the opening of a file, so a growing log stays the same log.
	//
	// Called before every read, not only when the file goes quiet: a rewrite
	// between two reads would otherwise be consumed as if it were more of the
	// same file, and the panel would show a line starting halfway through.
	//
	// `force` is set whenever the last read drained the file, which is the
	// moment a rewrite can actually slip in. While a backlog is being consumed
	// there is no such gap, so those reads only pay for a check occasionally.
	reopenIfStale := func(force bool) {
		if !force && time.Since(checkedAt) < headCheckInterval {
			return
		}
		checkedAt = time.Now()

		stat, err := os.Stat(path)
		if err != nil {
			return // gone for the moment; it may come back
		}

		stale := stat.Size() < offset ||
			!sameFile(file, stat) ||
			(len(head) > 0 && headPrintAt(path, len(head)) != head)

		if !stale {
			// A log that was shorter than the fingerprint when it was opened
			// has more of an opening now. Take it, so the next check has
			// something to compare against.
			if len(head) < headPrintBytes {
				head = headPrintAt(path, headPrintBytes)
			}
			return
		}

		replacement, err := os.Open(path)
		if err != nil {
			return
		}
		file.Close()
		file = replacement
		offset = 0
		head = headPrint(file, headPrintBytes)
	}

	buf := make([]byte, 32*1024)
	drained := true
	lastLine := time.Now()

	for {
		reopenIfStale(drained)

		n, err := file.Read(buf)
		if n > 0 {
			if _, werr := writer.Write(buf[:n]); werr != nil {
				return // the reader went away
			}
			offset += int64(n)
			lastLine = time.Now()
			// A full buffer means there is more waiting; anything less means
			// we are at the end of the file as it stands.
			drained = n < len(buf)
			continue
		}
		drained = true
		if err != nil && err != io.EOF {
			writer.CloseWithError(err)
			return
		}

		// A log being written to is worth checking often; one that has gone
		// quiet is not.
		wait := followIdleInterval
		if time.Since(lastLine) < followBusyFor {
			wait = followBusyInterval
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

const (
	// Enough of a file's opening to notice it started over, and cheap enough
	// to read this often.
	headPrintBytes = 64
	// Ceiling on how often the file behind the handle is re-examined. Below
	// human reaction time, and far above how often it is worth stat'ing a log.
	headCheckInterval = 200 * time.Millisecond
)

func headPrint(file *os.File, size int) string {
	buf := make([]byte, size)
	n, err := file.ReadAt(buf, 0)
	if err != nil && err != io.EOF {
		return ""
	}
	return string(buf[:n])
}

func headPrintAt(path string, size int) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	return headPrint(file, size)
}

func sameFile(file *os.File, stat os.FileInfo) bool {
	current, err := file.Stat()
	if err != nil {
		return false
	}
	return os.SameFile(current, stat)
}

// stream runs a command that keeps writing — logcat, in practice — with stderr
// folded into stdout by the script itself, so a failure reaches the panel
// instead of vanishing.
func (a *Android) stream(ctx context.Context, script string) (io.ReadCloser, error) {
	cmd := exec.CommandContext(ctx, "sh", "-c", script)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &processReader{ReadCloser: stdout, cmd: cmd}, nil
}

// processReader ties the pipe's lifetime to the process behind it: closing the
// reader kills logcat rather than leaving it writing into a pipe nobody reads.
type processReader struct {
	io.ReadCloser
	cmd *exec.Cmd
}

func (p *processReader) Close() error {
	err := p.ReadCloser.Close()
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	_ = p.cmd.Wait()
	return err
}

func (a *Android) Prop(ctx context.Context, name string) string {
	out, err := a.Exec(ctx, "getprop", name)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

func (a *Android) UptimeSeconds() int64 {
	out, err := a.Shell(context.Background(), "cat /proc/uptime")
	if err != nil {
		return 0
	}
	return uptimeSeconds(out, readProc("/proc/1/stat"))
}

// uptimeSeconds is how long *this* Android has been up, which is not the same
// as how long the kernel has.
//
// A container shares the host's kernel, so /proc/uptime inside one reports the
// host's uptime — N boxes on a server would all report the same climbing
// number. What did start when this Android started is its pid 1, so subtracting
// how long ago that happened gives the real answer. On a box with its own
// kernel init starts at boot, the subtraction is ~0, and this is the plain
// reading it always was; no container detection needed either way.
func uptimeSeconds(uptime, pid1Stat string) int64 {
	fields := strings.Fields(uptime)
	if len(fields) == 0 {
		return 0
	}
	secs, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0
	}
	if start, ok := procStartTicks(pid1Stat); ok {
		secs -= float64(start) / clockTicksPerSecond
	}
	if secs < 0 {
		return 0
	}
	return int64(secs)
}

// procStartTicks is field 22 of a /proc/<pid>/stat line: when the process
// started, in clock ticks since the kernel booted.
//
// Split from the right like procCPUTicks, for the same reason: field 2 is the
// executable name in parentheses and may contain spaces. Everything after the
// closing parenthesis begins at field 3, so field 22 is the 20th of that
// remainder.
func procStartTicks(line string) (uint64, bool) {
	end := strings.LastIndexByte(line, ')')
	if end < 0 {
		return 0, false
	}
	fields := strings.Fields(line[end+1:])
	if len(fields) < 20 {
		return 0, false
	}
	ticks, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return 0, false
	}
	return ticks, true
}

// procField pulls one whitespace-separated field out of a /proc file. These
// are the cheapest readings on the box: no fork, no dumpsys, a few hundred
// bytes each.
func readProc(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(data)
}

// LoadAvg is the whole machine's, deliberately. Linux has no per-container load
// average — there is nothing to scope it to — so boxes sharing a host all
// report the same figure, and reading it as one box's own load is a mistake.
func (a *Android) LoadAvg() (float64, float64, float64) {
	fields := strings.Fields(readProc("/proc/loadavg"))
	if len(fields) < 3 {
		return 0, 0, 0
	}
	one, _ := strconv.ParseFloat(fields[0], 64)
	five, _ := strconv.ParseFloat(fields[1], 64)
	fifteen, _ := strconv.ParseFloat(fields[2], 64)
	return one, five, fifteen
}

func (a *Android) Memory() (uint64, uint64) {
	// /proc/meminfo inside a container is the host's, so a memory-limited box
	// would report the whole server's RAM. The cgroup knows the real ceiling.
	if total, available, ok := cgroupMemory(
		readProc("/sys/fs/cgroup/memory.max"),
		readProc("/sys/fs/cgroup/memory.current"),
	); ok {
		return total, available
	}
	return meminfoMemory(readProc("/proc/meminfo"))
}

// cgroupMemory reads the cgroup v2 limit and usage. Not ok when there is no
// cgroup at all, or when it is unlimited — `memory.max` reads "max" then, and
// the host's own total is the honest answer, which is what a real box gives.
func cgroupMemory(max, current string) (uint64, uint64, bool) {
	limit, err := strconv.ParseUint(strings.TrimSpace(max), 10, 64)
	if err != nil || limit == 0 {
		return 0, 0, false
	}
	used, err := strconv.ParseUint(strings.TrimSpace(current), 10, 64)
	if err != nil {
		return 0, 0, false
	}
	if used > limit {
		used = limit
	}
	return limit, limit - used, true
}

func meminfoMemory(meminfo string) (uint64, uint64) {
	var total, available uint64
	scanner := bufio.NewScanner(strings.NewReader(meminfo))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		// Values are in kB; the third field is the unit when present.
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			total = value * 1024
		case "MemAvailable:":
			available = value * 1024
		}
		if total > 0 && available > 0 {
			break
		}
	}
	return total, available
}

func (a *Android) CPUCount() int {
	return runtime.NumCPU()
}

// --- Temperature -----------------------------------------------------------

// scaleTemp turns whatever a thermal node printed into degrees Celsius.
//
// The kernel's thermal framework documents millidegrees, and most SoCs follow
// it — but Amlogic and Rockchip boxes, which is most of this fleet, ship nodes
// in deci-degrees or in plain degrees depending on the vendor tree. Reading a
// 45000 as 45000 °C is worse than reading nothing, so the magnitude picks the
// divisor: anything a box could survive is under 150 °C.
func scaleTemp(raw float64) (float64, bool) {
	for _, divisor := range []float64{1, 10, 1000} {
		value := raw / divisor
		// -30 rather than 0: a box in an unheated shed in winter is plausible,
		// and a sensor reporting a hard zero usually means "not wired up".
		if value >= -30 && value <= 150 && value != 0 {
			return value, true
		}
	}
	return 0, false
}

// Temperatures reads the box's thermal zones.
//
// Zones are unlabelled on plenty of ROMs and there is no portable "the CPU
// one", so this prefers a zone whose type names the SoC and falls back to the
// hottest zone it found. The hottest is the honest fallback: whatever is
// closest to throttling is what an operator wants to see.
func (a *Android) Temperatures() (float64, float64) {
	entries, err := os.ReadDir("/sys/class/thermal")
	var cpu, hottest float64
	var haveCPU, haveHottest bool

	if err == nil {
		for _, entry := range entries {
			name := entry.Name()
			if !strings.HasPrefix(name, "thermal_zone") {
				continue
			}
			base := "/sys/class/thermal/" + name
			raw, parseErr := strconv.ParseFloat(strings.TrimSpace(readProc(base+"/temp")), 64)
			if parseErr != nil {
				continue
			}
			value, ok := scaleTemp(raw)
			if !ok {
				continue
			}

			if !haveHottest || value > hottest {
				hottest, haveHottest = value, true
			}

			// tsens is Qualcomm's name for the SoC sensor; the others are what
			// the Amlogic and Rockchip trees use for the same thing.
			zoneType := strings.ToLower(strings.TrimSpace(readProc(base + "/type")))
			isCPU := strings.Contains(zoneType, "cpu") ||
				strings.Contains(zoneType, "tsens") ||
				strings.Contains(zoneType, "soc") ||
				strings.Contains(zoneType, "ap_therm")
			if isCPU && (!haveCPU || value > cpu) {
				cpu, haveCPU = value, true
			}
		}
	}

	if !haveCPU && haveHottest {
		cpu = hottest
	}

	// Battery is its own subsystem and always deci-degrees, but a mains-powered
	// TV box usually has no battery node at all — hence the same scale-or-drop
	// treatment rather than trusting the unit.
	var battery float64
	if raw, parseErr := strconv.ParseFloat(
		strings.TrimSpace(readProc("/sys/class/power_supply/battery/temp")), 64,
	); parseErr == nil {
		if value, ok := scaleTemp(raw); ok {
			battery = value
		}
	}

	return cpu, battery
}

// --- Per-app CPU and memory ------------------------------------------------

// Linux exports process CPU time in USER_HZ, which is 100 on every Android
// kernel that ships. Go has no sysconf(_SC_CLK_TCK), and getting this wrong
// only scales the percentage, so the constant is the pragmatic answer.
const clockTicksPerSecond = 100

// ownsProcess reports whether a /proc cmdline belongs to pkg.
//
// Android names an app's process after its package, and its extra processes
// after the package plus a colon suffix (`com.example:remote`). Matching the
// prefix alone would also catch `com.example.other`, which is a different app,
// so the suffix has to be a colon.
func ownsProcess(cmdline, pkg string) bool {
	if cmdline == pkg {
		return true
	}
	return strings.HasPrefix(cmdline, pkg+":")
}

// processName is /proc/<pid>/cmdline's first NUL-separated argument, which for
// an Android app is the process name rather than a path.
func processName(pid int) string {
	raw := readProc("/proc/" + strconv.Itoa(pid) + "/cmdline")
	if raw == "" {
		return ""
	}
	if i := strings.IndexByte(raw, 0); i >= 0 {
		raw = raw[:i]
	}
	return strings.TrimSpace(raw)
}

// pidsFor finds every live pid belonging to each package, in one walk of /proc.
//
// The walk is the expensive part — a few hundred small reads — so the resolved
// pids are cached and the walk only happens when a cached pid has died or
// belongs to something else now. In the steady state, where the scanner has
// been up for days, this costs one cmdline read per process per beat.
func (a *Android) pidsFor(packages []string) map[string][]int {
	a.cpuMu.Lock()
	found := make(map[string][]int, len(packages))
	var stale bool
	for _, pkg := range packages {
		cached := a.pidCache[pkg]
		if len(cached) == 0 {
			stale = true
			continue
		}
		live := make([]int, 0, len(cached))
		for _, pid := range cached {
			if ownsProcess(processName(pid), pkg) {
				live = append(live, pid)
			}
		}
		if len(live) != len(cached) {
			// A process came or went, so the cache no longer describes the box.
			stale = true
			continue
		}
		found[pkg] = live
	}
	a.cpuMu.Unlock()

	if !stale {
		return found
	}

	entries, err := os.ReadDir("/proc")
	if err != nil {
		return found
	}
	fresh := make(map[string][]int, len(packages))
	for _, entry := range entries {
		pid, convErr := strconv.Atoi(entry.Name())
		if convErr != nil {
			continue // /proc/self, /proc/meminfo and friends
		}
		name := processName(pid)
		if name == "" {
			continue
		}
		for _, pkg := range packages {
			if ownsProcess(name, pkg) {
				fresh[pkg] = append(fresh[pkg], pid)
				break
			}
		}
	}

	a.cpuMu.Lock()
	a.pidCache = fresh
	a.cpuMu.Unlock()
	return fresh
}

// procCPUTicks is utime+stime out of /proc/<pid>/stat.
//
// The stat line cannot be split on spaces from the left: field 2 is the
// executable name in parentheses and may itself contain spaces. Everything
// after the closing parenthesis is safe, and utime/stime are fields 14 and 15
// overall — the 12th and 13th of that remainder.
func procCPUTicks(pid int) (uint64, bool) {
	line := readProc("/proc/" + strconv.Itoa(pid) + "/stat")
	end := strings.LastIndexByte(line, ')')
	if end < 0 {
		return 0, false
	}
	fields := strings.Fields(line[end+1:])
	if len(fields) < 13 {
		return 0, false
	}
	utime, err1 := strconv.ParseUint(fields[11], 10, 64)
	stime, err2 := strconv.ParseUint(fields[12], 10, 64)
	if err1 != nil || err2 != nil {
		return 0, false
	}
	return utime + stime, true
}

// procRSSBytes is the resident set out of /proc/<pid>/statm, whose second
// field is resident pages.
func procRSSBytes(pid int) uint64 {
	fields := strings.Fields(readProc("/proc/" + strconv.Itoa(pid) + "/statm"))
	if len(fields) < 2 {
		return 0
	}
	pages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0
	}
	return pages * uint64(os.Getpagesize())
}

func (a *Android) ProcessStats(packages []string) []proto.ProcessStats {
	if len(packages) == 0 {
		return nil
	}

	pids := a.pidsFor(packages)
	now := time.Now()
	stats := make([]proto.ProcessStats, 0, len(packages))

	a.cpuMu.Lock()
	defer a.cpuMu.Unlock()
	if a.lastCPU == nil {
		a.lastCPU = map[string]cpuReading{}
	}

	for _, pkg := range packages {
		live := pids[pkg]
		if len(live) == 0 {
			// Not running. Drop the baseline too, so the first beat after it
			// comes back does not bill it for the whole time it was dead.
			delete(a.lastCPU, pkg)
			continue
		}

		var ticks, rss uint64
		var readAny bool
		for _, pid := range live {
			if t, ok := procCPUTicks(pid); ok {
				ticks += t
				readAny = true
			}
			rss += procRSSBytes(pid)
		}
		if !readAny {
			continue
		}

		count := len(live)
		entry := proto.ProcessStats{
			PackageName:  pkg,
			RSSBytes:     rss,
			ProcessCount: &count,
		}

		// A rate needs two readings. The first beat for a package reports
		// memory only rather than inventing a number from uptime, which would
		// read as a long-run average and not as "right now".
		if prev, ok := a.lastCPU[pkg]; ok && ticks >= prev.ticks {
			elapsed := now.Sub(prev.at).Seconds()
			if elapsed > 0 {
				used := float64(ticks-prev.ticks) / clockTicksPerSecond
				entry.CPUPercent = used / elapsed * 100
			}
		}
		a.lastCPU[pkg] = cpuReading{ticks: ticks, at: now}

		stats = append(stats, entry)
	}

	return stats
}

// `pm list packages -3 --show-versioncode` prints one line per third-party
// package: "package:com.example.app versionCode:1234". That is the whole
// inventory in a single call — the alternative, a dumpsys per package, is
// what makes this expensive enough to be worth doing rarely.
func (a *Android) ThirdPartyPackages(ctx context.Context) ([]proto.PackageInfo, error) {
	out, err := a.Exec(ctx, "pm", "list", "packages", "-3", "--show-versioncode")
	if err != nil {
		// Older builds of pm do not know --show-versioncode; the names alone
		// are still worth having.
		out, err = a.Exec(ctx, "pm", "list", "packages", "-3")
		if err != nil {
			return nil, err
		}
	}

	var packages []proto.PackageInfo
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		info, ok := parsePackageLine(scanner.Text())
		if ok {
			packages = append(packages, info)
		}
	}
	return packages, scanner.Err()
}

// ParsePackageLine is split out so the parsing is testable without a device.
func parsePackageLine(line string) (proto.PackageInfo, bool) {
	fields := strings.Fields(strings.TrimSpace(line))
	if len(fields) == 0 || !strings.HasPrefix(fields[0], "package:") {
		return proto.PackageInfo{}, false
	}

	name := strings.TrimPrefix(fields[0], "package:")
	if name == "" {
		return proto.PackageInfo{}, false
	}

	info := proto.PackageInfo{PackageName: name, Installed: true}
	for _, field := range fields[1:] {
		if code, ok := strings.CutPrefix(field, "versionCode:"); ok {
			info.VersionCode = code
		}
	}
	return info, true
}

var (
	versionNameRe = regexp.MustCompile(`versionName=([^\s]+)`)
	versionCodeRe = regexp.MustCompile(`versionCode=(\d+)`)
)

func (a *Android) PackageInfo(ctx context.Context, pkg string) (proto.PackageInfo, error) {
	info := proto.PackageInfo{PackageName: pkg}

	out, err := a.Exec(ctx, "dumpsys", "package", pkg)
	if err != nil || strings.TrimSpace(out) == "" {
		// dumpsys prints nothing useful for a package that is not installed.
		info.Installed = false
		return info, nil
	}
	if !strings.Contains(out, "Package [") {
		info.Installed = false
		return info, nil
	}

	info.Installed = true
	// Take the first match: later blocks in dumpsys describe hidden/system
	// copies of the package rather than what is actually running.
	if m := versionNameRe.FindStringSubmatch(out); len(m) == 2 {
		info.VersionName = m[1]
	}
	if m := versionCodeRe.FindStringSubmatch(out); len(m) == 2 {
		info.VersionCode = m[1]
	}
	return info, nil
}

func (a *Android) DeviceInfo(ctx context.Context) proto.DeviceInfo {
	sdk, _ := strconv.Atoi(a.Prop(ctx, "ro.build.version.sdk"))
	density, _ := strconv.Atoi(a.Prop(ctx, "ro.sf.lcd_density"))

	// An explicit serial wins over anything the box reports. A container has no
	// stable one of its own, and the hub keys a device on this string alone.
	serial := a.serialOverride
	if serial == "" {
		serial = a.Prop(ctx, "ro.serialno")
	}
	if serial == "" {
		serial = a.Prop(ctx, "ro.boot.serialno")
	}
	if serial == "" {
		// Some cheap TV boxes ship without a serial property at all. A MAC is
		// stable enough to identify the box across re-enrollments.
		serial = fallbackSerial(ctx, a)
	}

	abi := a.Prop(ctx, "ro.product.cpu.abi")

	return proto.DeviceInfo{
		Serial:         serial,
		Manufacturer:   a.Prop(ctx, "ro.product.manufacturer"),
		Model:          a.Prop(ctx, "ro.product.model"),
		AndroidVersion: a.Prop(ctx, "ro.build.version.release"),
		SdkInt:         sdk,
		Abi:            abi,
		Density:        density,
		LocalIp:        LocalIP(),
	}
}

// LocalIP returns the box's LAN address, empty when it has none.
//
// A TV box normally has exactly one usable interface up (wlan0 or eth0), but
// it can also carry docker/tun leftovers and a link-local 169.254 address
// while DHCP is still running. Prefer a real private address, and among those
// the one on an interface that looks like the box's own network card.
func LocalIP() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}

	var fallback string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipNet.IP.To4()
			if ip == nil || !ip.IsPrivate() || ip.IsLinkLocalUnicast() {
				continue
			}
			if isPhysicalIface(iface.Name) {
				return ip.String()
			}
			if fallback == "" {
				fallback = ip.String()
			}
		}
	}
	return fallback
}

func isPhysicalIface(name string) bool {
	for _, prefix := range []string{"wlan", "eth", "en", "wl", "rmnet"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func fallbackSerial(ctx context.Context, a *Android) string {
	out, err := a.Shell(ctx, "cat /sys/class/net/*/address 2>/dev/null | head -n 1")
	if err == nil {
		mac := strings.TrimSpace(out)
		if mac != "" && mac != "00:00:00:00:00:00" {
			return "mac-" + strings.ReplaceAll(mac, ":", "")
		}
	}
	return fmt.Sprintf("unknown-%d", time.Now().UnixNano())
}

// Metrics gathers everything the hub wants on a heartbeat.
//
// Cost matters here: this runs every 20 seconds on a box whose day job is
// scanning. Load, memory and cpu count are three small /proc reads and are
// always included. The package versions are not: `dumpsys package` prints a
// wall of text per package, so only the packages the hub asked to track get
// one, and the full third-party inventory — a single `pm list packages` — is
// gathered on request rather than on every beat.
func Metrics(ctx context.Context, s System, packages []string, withInventory bool) proto.DeviceMetrics {
	free, total, _ := s.Disk("/data")
	one, five, fifteen := s.LoadAvg()
	memTotal, memAvailable := s.Memory()
	cpuTemp, batteryTemp := s.Temperatures()

	m := proto.DeviceMetrics{
		FreeBytes:         free,
		TotalBytes:        total,
		UptimeSeconds:     s.UptimeSeconds(),
		LoadAvg1:          one,
		LoadAvg5:          five,
		LoadAvg15:         fifteen,
		CPUCount:          s.CPUCount(),
		MemTotalBytes:     memTotal,
		MemAvailableBytes: memAvailable,
		CPUTempC:          cpuTemp,
		BatteryTempC:      batteryTemp,
		// Same cost class as the readings above — a handful of small /proc
		// reads for the tracked apps — so it rides every beat rather than
		// waiting for the inventory pass.
		Processes: s.ProcessStats(packages),
	}

	seen := map[string]bool{}
	for _, pkg := range packages {
		info, err := s.PackageInfo(ctx, pkg)
		if err != nil {
			continue
		}
		seen[info.PackageName] = true
		m.Packages = append(m.Packages, info)
	}

	if withInventory {
		installed, err := s.ThirdPartyPackages(ctx)
		if err == nil {
			m.PackagesComplete = true
			for _, info := range installed {
				// The tracked entry already carries a versionName, which the
				// inventory does not: never overwrite it with the thinner one.
				if seen[info.PackageName] {
					continue
				}
				m.Packages = append(m.Packages, info)
			}
		}
	}

	return m
}

// ParseDumpsysVersion is exported for tests and for the verify step, which
// re-reads dumpsys output after an install.
func ParseDumpsysVersion(out string) (versionName string, versionCode string) {
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		line := scanner.Text()
		if versionName == "" {
			if m := versionNameRe.FindStringSubmatch(line); len(m) == 2 {
				versionName = m[1]
			}
		}
		if versionCode == "" {
			if m := versionCodeRe.FindStringSubmatch(line); len(m) == 2 {
				versionCode = m[1]
			}
		}
		if versionName != "" && versionCode != "" {
			break
		}
	}
	return versionName, versionCode
}
