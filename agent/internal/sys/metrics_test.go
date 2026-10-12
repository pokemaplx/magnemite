package sys

import "testing"

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
