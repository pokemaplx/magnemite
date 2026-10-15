package sys

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"magnemite/agent/internal/proto"
)

// A plausible /proc/1/stat. Field 22, the starttime, is 4523 ticks — 45.23s at
// the 100Hz USER_HZ every Android kernel ships.
const pid1Stat = "1 (init) S 0 0 0 0 -1 4194560 1234 0 0 0 5 12 0 0 20 0 1 0 4523 12345678 456 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0"

func TestUptimeSeconds(t *testing.T) {
	cases := []struct {
		name     string
		uptime   string
		pid1Stat string
		want     int64
	}{
		{
			// The reading the dashboard used to get on every box: the kernel's.
			name:     "container reports its own age, not the host's",
			uptime:   "100000.00 50000.00\n",
			pid1Stat: pid1Stat,
			want:     99954,
		},
		{
			// A box with its own kernel: init starts at boot, so the
			// subtraction is a no-op and this is the plain reading.
			name:     "real box is unaffected",
			uptime:   "3600.42 1200.00\n",
			pid1Stat: "1 (init) S 0 0 0 0 -1 4194560 1234 0 0 0 5 12 0 0 20 0 1 0 0 12345678 456",
			want:     3600,
		},
		{
			// The executable name is field 2 and may hold spaces and
			// parentheses; splitting from the left would land on the wrong one.
			name:     "process name with spaces and a paren",
			uptime:   "100000.00 50000.00\n",
			pid1Stat: "1 (we ird) init) S 0 0 0 0 -1 4194560 1234 0 0 0 5 12 0 0 20 0 1 0 4523 12345678",
			want:     99954,
		},
		{
			name:     "unreadable pid 1 falls back to the raw uptime",
			uptime:   "3600.42 1200.00\n",
			pid1Stat: "",
			want:     3600,
		},
		{
			name:     "truncated stat line falls back to the raw uptime",
			uptime:   "3600.42 1200.00\n",
			pid1Stat: "1 (init) S 0 0 0",
			want:     3600,
		},
		{
			// Only reachable if the two files disagree. Never report a negative
			// uptime at the hub.
			name:     "start after boot clamps at zero",
			uptime:   "10.00 5.00\n",
			pid1Stat: pid1Stat,
			want:     0,
		},
		{
			name:     "no uptime at all",
			uptime:   "",
			pid1Stat: pid1Stat,
			want:     0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := uptimeSeconds(tc.uptime, tc.pid1Stat); got != tc.want {
				t.Errorf("uptimeSeconds() = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestCgroupMemory(t *testing.T) {
	cases := []struct {
		name               string
		max, current, stat string
		wantTotal          uint64
		wantAvailable      uint64
		wantOK             bool
	}{
		{
			// The reading this fix exists for. Android mmaps the ROM and the
			// APKs and the scanner reads files, all of it charged to the box as
			// page cache -- so the unsubtracted number reports a healthy idle
			// box as nearly full and the chart flatlines at the ceiling.
			name:          "page cache is not memory used",
			max:           "4294967296\n",
			current:       "4000000000\n",
			stat:          "anon 500000000\nfile 3500000000\ninactive_file 3400000000\nactive_file 100000000\n",
			wantTotal:     4294967296,
			wantAvailable: 4294967296 - 600000000,
			wantOK:        true,
		},
		{
			// docker's own guard, and not paranoia: the two values are separate
			// reads, so a box at its limit can read a larger inactive_file than
			// the usage sampled a moment earlier. Subtracting anyway would
			// underflow to sixteen exabytes available.
			name:          "inactive_file above usage is ignored",
			max:           "1000\n",
			current:       "400\n",
			stat:          "inactive_file 900\n",
			wantTotal:     1000,
			wantAvailable: 600,
			wantOK:        true,
		},
		{
			// A missing memory.stat reports the raw usage rather than deferring
			// to meminfo, which is what docker does: the limit is still the
			// box's own, and the host's total would be a worse answer.
			name:          "no memory.stat falls back to the raw usage",
			max:           "1000\n",
			current:       "400\n",
			wantTotal:     1000,
			wantAvailable: 600,
			wantOK:        true,
		},
		{
			name:          "a malformed inactive_file is ignored",
			max:           "1000\n",
			current:       "400\n",
			stat:          "inactive_file not-a-number\n",
			wantTotal:     1000,
			wantAvailable: 600,
			wantOK:        true,
		},
		{
			name:          "limited container",
			max:           "8589934592\n",
			current:       "2147483648\n",
			wantTotal:     8589934592,
			wantAvailable: 6442450944,
			wantOK:        true,
		},
		{
			// No limit set: the host's own total is the honest answer, which is
			// what /proc/meminfo already gives.
			name:   "unlimited cgroup defers to meminfo",
			max:    "max\n",
			wantOK: false,
		},
		{
			name:   "no cgroup at all defers to meminfo",
			max:    "",
			wantOK: false,
		},
		{
			name:    "unreadable usage defers to meminfo",
			max:     "8589934592\n",
			current: "",
			wantOK:  false,
		},
		{
			name:          "usage over the limit reports nothing available",
			max:           "1000\n",
			current:       "1200\n",
			wantTotal:     1000,
			wantAvailable: 0,
			wantOK:        true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			total, available, ok := cgroupMemory(tc.max, tc.current, tc.stat)
			if ok != tc.wantOK {
				t.Fatalf("cgroupMemory() ok = %v, want %v", ok, tc.wantOK)
			}
			if !ok {
				return
			}
			if total != tc.wantTotal || available != tc.wantAvailable {
				t.Errorf("cgroupMemory() = (%d, %d), want (%d, %d)",
					total, available, tc.wantTotal, tc.wantAvailable)
			}
		})
	}
}

func TestMeminfoMemory(t *testing.T) {
	const meminfo = `MemTotal:        2027384 kB
MemFree:          123456 kB
MemAvailable:    1048576 kB
Buffers:           12345 kB
`
	total, available := meminfoMemory(meminfo)
	if total != 2027384*1024 {
		t.Errorf("total = %d, want %d", total, 2027384*1024)
	}
	if available != 1048576*1024 {
		t.Errorf("available = %d, want %d", available, 1048576*1024)
	}

	if total, available := meminfoMemory(""); total != 0 || available != 0 {
		t.Errorf("empty meminfo = (%d, %d), want (0, 0)", total, available)
	}
}

func TestMeminfoSwap(t *testing.T) {
	const meminfo = "MemTotal:       32000000 kB\nMemFree:  1000000 kB\nSwapTotal:      32000000 kB\nSwapFree:       31000000 kB\n"
	total, free, ok := meminfoSwap(meminfo)
	if !ok {
		t.Fatal("meminfoSwap() ok = false, want true")
	}
	if total != 32000000*1024 || free != 31000000*1024 {
		t.Errorf("meminfoSwap() = (%d, %d), want (%d, %d)",
			total, free, uint64(32000000)*1024, uint64(31000000)*1024)
	}

	// A machine with no swap configured. Zero is the answer, and `ok` stays
	// true: the hub has to be able to tell this from a kernel that never said,
	// because it is a machine the OOM killer reaches sooner.
	total, free, ok = meminfoSwap("MemTotal: 100 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n")
	if !ok || total != 0 || free != 0 {
		t.Errorf("no swap = (%d, %d, %v), want (0, 0, true)", total, free, ok)
	}

	// No SwapTotal line at all is the one case that is genuinely unknown.
	if _, _, ok := meminfoSwap("MemTotal: 100 kB\n"); ok {
		t.Error("meminfo without SwapTotal reported ok = true")
	}
}

func TestBusyTicks(t *testing.T) {
	// user nice system idle iowait irq softirq steal
	const stat = "cpu  100 20 50 1000 30 5 5 0\ncpu0 50 10 25 500 15 2 2 0\nintr 12345\n"
	busy, ok := busyTicks(stat)
	if !ok {
		t.Fatal("busyTicks() ok = false, want true")
	}
	// Everything but idle (1000) and iowait (30), and the per-core `cpu0` line
	// must not be added in -- doubling every reading is the bug this guards.
	const want = 100 + 20 + 50 + 5 + 5 + 0
	if busy != want {
		t.Errorf("busyTicks() = %d, want %d", busy, want)
	}

	if _, ok := busyTicks("intr 1 2 3\n"); ok {
		t.Error("busyTicks() with no cpu line reported ok = true")
	}
}

func TestCPURate(t *testing.T) {
	base := time.Now()
	// Two and a half cores spent over one second.
	prev := machineCPU{seconds: 10, at: base}
	cur := machineCPU{seconds: 12.5, at: base.Add(time.Second)}
	got := cpuRate(prev, cur, time.Minute)
	if got == nil {
		t.Fatal("cpuRate() = nil, want 250")
	}
	if *got < 249.9 || *got > 250.1 {
		t.Errorf("cpuRate() = %v, want 250", *got)
	}

	// Not clamped at 100. An 8-core machine at full tilt reports 800, and
	// clamping is how that would look merely busy.
	eight := cpuRate(machineCPU{seconds: 0, at: base}, machineCPU{seconds: 8, at: base.Add(time.Second)}, time.Minute)
	if eight == nil || *eight < 799 || *eight > 801 {
		t.Errorf("eight cores = %v, want ~800", eight)
	}

	cases := []struct {
		name      string
		prev, cur machineCPU
		maxAge    time.Duration
		wantNil   string
	}{
		{
			name:    "no previous reading",
			prev:    machineCPU{},
			cur:     machineCPU{seconds: 5, at: base},
			maxAge:  time.Minute,
			wantNil: "a rate needs two readings",
		},
		{
			name:    "counter went backwards",
			prev:    machineCPU{seconds: 100, at: base},
			cur:     machineCPU{seconds: 1, at: base.Add(time.Second)},
			maxAge:  time.Minute,
			wantNil: "a recreated container restarts its counter at zero",
		},
		{
			name:    "no elapsed time",
			prev:    machineCPU{seconds: 1, at: base},
			cur:     machineCPU{seconds: 2, at: base},
			maxAge:  time.Minute,
			wantNil: "two beats inside one clock tick",
		},
		{
			name:    "stale baseline",
			prev:    machineCPU{seconds: 1, at: base},
			cur:     machineCPU{seconds: 2, at: base.Add(time.Hour)},
			maxAge:  time.Minute,
			wantNil: "an hour-old baseline publishes its own average as now",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := cpuRate(tc.prev, tc.cur, tc.maxAge); got != nil {
				t.Errorf("cpuRate() = %v, want nil (%s)", *got, tc.wantNil)
			}
		})
	}
}

// hostLike is a System that answers like a machine rather than a box: it has
// /proc readings and refuses every Android question, which is exactly what
// internal/sys.Host does.
type hostLike struct{ System }

func (hostLike) Disk(string) (uint64, uint64, error)        { return 1 << 30, 1 << 31, nil }
func (hostLike) LoadAvg() (float64, float64, float64)       { return 0.1, 0.2, 0.3 }
func (hostLike) Memory() (uint64, uint64)                   { return 1 << 33, 1 << 32 }
func (hostLike) Temperatures() (float64, float64)           { return 0, 0 }
func (hostLike) Swap() (uint64, uint64, bool)               { return 0, 0, true }
func (hostLike) UptimeSeconds() int64                       { return 42 }
func (hostLike) CPUCount() int                              { return 4 }
func (hostLike) CPUPercent() *float64                       { return nil }
func (hostLike) ProcessStats([]string) []proto.ProcessStats { return nil }
func (hostLike) PackageInfo(context.Context, string) (proto.PackageInfo, error) {
	return proto.PackageInfo{}, errors.New("not android")
}
func (hostLike) ThirdPartyPackages(context.Context) ([]proto.PackageInfo, error) {
	return nil, errors.New("not android")
}

// A nil slice marshals as JSON `null`, `packages` has no omitempty, and the
// hub's schema wants an array — so this is what had a healthy machine reading
// as offline: every frame it sent was dropped whole, liveness included.
func TestMetricsAlwaysSendsPackagesAsAnArray(t *testing.T) {
	m := Metrics(context.Background(), hostLike{}, []string{"com.nianticlabs.pokemongo"}, true)

	if m.Packages == nil {
		t.Fatal("Packages is nil, which marshals as null")
	}

	data, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"packages":[]`) {
		t.Errorf("want \"packages\":[] on the wire, got %s", data)
	}
	if strings.Contains(string(data), `"packages":null`) {
		t.Error(`"packages":null is the frame the hub drops`)
	}
}

// blocking is a System whose Android questions never come back, which is what
// a box looks like while its framework is restarting: every `dumpsys` sits
// there until its deadline.
type blocking struct{ hostLike }

func (blocking) PackageInfo(ctx context.Context, _ string) (proto.PackageInfo, error) {
	<-ctx.Done()
	return proto.PackageInfo{}, ctx.Err()
}
func (blocking) ThirdPartyPackages(ctx context.Context) ([]proto.PackageInfo, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

// The property the heartbeat now rests on: the half of a reading that every
// beat carries asks the box nothing that can hang. A beat that waits on
// dumpsys is a beat that arrives after the hub has given up, and a box sitting
// there perfectly healthy gets announced as unreachable.
func TestBaseMetricsNeverWaitsOnTheFramework(t *testing.T) {
	done := make(chan proto.DeviceMetrics, 1)
	go func() { done <- BaseMetrics(blocking{}, []string{"com.nianticlabs.pokemongo"}) }()

	select {
	case m := <-done:
		if m.UptimeSeconds != 42 {
			t.Errorf("UptimeSeconds = %d, want the cheap reading 42", m.UptimeSeconds)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("BaseMetrics blocked on a package question; it must only read /proc")
	}
}

// The same hazard as TestMetricsAlwaysSendsPackagesAsAnArray, guarded on the
// path it moved to: BaseMetrics is what every single heartbeat sends now, so a
// nil slice here drops every frame rather than the occasional one.
func TestBaseMetricsAlwaysSendsPackagesAsAnArray(t *testing.T) {
	data, err := json.Marshal(BaseMetrics(hostLike{}, nil))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"packages":[]`) {
		t.Errorf("want \"packages\":[] on the wire, got %s", data)
	}
}

// "No answer" and "nothing installed" have to stay different at the hub: it
// only marks an app uninstalled when complete is true, so a refusal must come
// back incomplete rather than as an empty inventory.
func TestPackageVersionsRefusalIsNotAnEmptyInventory(t *testing.T) {
	infos, complete := PackageVersions(context.Background(), hostLike{}, []string{"com.x"}, true)
	if infos == nil {
		t.Error("infos is nil, which marshals as null")
	}
	if len(infos) != 0 {
		t.Errorf("got %d packages from a System that refuses them", len(infos))
	}
	if complete {
		t.Error("complete is true after ThirdPartyPackages failed; the hub would uninstall every app")
	}
}
