package host

import (
	"context"
	"testing"
)

// The serial is what matches a container back to its instance row, so getting
// it out of the container's own command line correctly is the whole of whether
// adoption works. Nothing else in this package is as load-bearing.
func TestSerialFromCmd(t *testing.T) {
	cases := []struct {
		name string
		cmd  []string
		want string
	}{
		{
			name: "the namespaced property, which the start script reads",
			cmd: []string{
				"ro.magnemite.serial=rd-abc123-01",
				"androidboot.redroid_gpu_mode=guest",
			},
			want: "rd-abc123-01",
		},
		{
			// What the hand-written compose file in this repo sets. Reading it
			// is what lets such a machine be adopted rather than having every
			// one of its containers treated as a stranger.
			name: "ro.serialno as a fallback",
			cmd:  []string{"ro.serialno=magnemite-box-01", "androidboot.use_memfd=true"},
			want: "magnemite-box-01",
		},
		{
			// Both present: the namespaced one wins wherever it appears, not
			// whichever comes first.
			name: "the namespaced one wins even when it comes second",
			cmd:  []string{"ro.serialno=old-name", "ro.magnemite.serial=rd-abc123-02"},
			want: "rd-abc123-02",
		},
		{
			name: "no serial at all",
			cmd:  []string{"androidboot.redroid_gpu_mode=guest"},
			want: "",
		},
		{
			// An empty value is not a serial. Treating it as one would match a
			// container to whichever instance row also had none.
			name: "an empty value is not a serial",
			cmd:  []string{"ro.magnemite.serial=", "ro.serialno=real-one"},
			want: "real-one",
		},
		{
			name: "nothing at all",
			cmd:  nil,
			want: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := serialFromCmd(tc.cmd); got != tc.want {
				t.Errorf("serialFromCmd() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestFakeReporter(t *testing.T) {
	t.Setenv("MAGNEMITE_FAKE_HOST_PREFIX", "abc123")
	r := NewFakeReporter("magnemite-redroid", 3)

	got := r.Report(context.Background())
	if got == nil {
		t.Fatal("Report() = nil, want a report")
	}
	if len(got.Containers) != 3 {
		t.Fatalf("Containers = %d, want 3", len(got.Containers))
	}
	// The serial has to be in the shape the hub mints, or the fake exercises
	// nothing: a container whose serial matches no row is deliberately ignored.
	if got.Containers[0].Serial != "rd-abc123-01" {
		t.Errorf("first serial = %q, want rd-abc123-01", got.Containers[0].Serial)
	}
	if got.BinderOk == nil || !*got.BinderOk {
		t.Error("BinderOk should be true by default")
	}
	if got.DockerVersion == "" {
		t.Error("DockerVersion should be set when docker is up")
	}

	// A crash-looping instance, which is what a REDROID_INSTANCE_DOWN rule acts
	// on and what the restart count distinguishes from merely stopped.
	r.SetContainerState(2, "restarting", 7)
	got = r.Report(context.Background())
	if got.Containers[1].State != "restarting" {
		t.Errorf("state = %q, want restarting", got.Containers[1].State)
	}
	if got.Containers[1].RestartCount == nil || *got.Containers[1].RestartCount != 7 {
		t.Errorf("restart count = %v, want 7", got.Containers[1].RestartCount)
	}
}

// The agent is up and the daemon is not. A different signal from the machine
// going offline, with a different fix, and the point of being able to reproduce
// it without a VPS.
func TestFakeReporterDockerDown(t *testing.T) {
	t.Setenv("MAGNEMITE_FAKE_DOCKER_DOWN", "1")
	got := NewFakeReporter("magnemite-redroid", 2).Report(context.Background())

	if got.DockerVersion != "" {
		t.Errorf("DockerVersion = %q, want empty", got.DockerVersion)
	}
	// Nil rather than empty: "could not be asked" has to stay different from
	// "asked, and there are none", or a wedged daemon would read as a machine
	// somebody had drained on purpose.
	if got.Containers != nil {
		t.Errorf("Containers = %v, want nil when docker is down", got.Containers)
	}
	// The machine's own facts survive, because they do not come from docker.
	if got.Kernel == "" {
		t.Error("Kernel should still be reported with docker down")
	}
}
