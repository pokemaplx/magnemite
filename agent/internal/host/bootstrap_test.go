package host

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"magnemite/agent/internal/proto"
)

func TestParseStep(t *testing.T) {
	cases := []struct {
		line   string
		want   proto.BootstrapStep
		parsed bool
	}{
		{"::step arch ok aarch64", proto.BootstrapStep{Name: "arch", Ok: true, Detail: "aarch64"}, true},
		{"::step binder ok", proto.BootstrapStep{Name: "binder", Ok: true}, true},
		// A warning is not a failure: a machine with no swap runs, and calling
		// it failed would stop a re-run that was going to work.
		{"::step swap warn could not create /swapfile", proto.BootstrapStep{Name: "swap", Ok: true, Detail: "could not create /swapfile"}, true},
		{"::step docker fail could not install docker: E: no such package", proto.BootstrapStep{Name: "docker", Ok: false, Detail: "could not install docker: E: no such package"}, true},
		// Everything else on stdout is apt and docker being noisy.
		{"Get:1 http://deb.debian.org bookworm InRelease", proto.BootstrapStep{}, false},
		{"::step", proto.BootstrapStep{}, false},
		{"::step docker", proto.BootstrapStep{}, false},
		{"::step docker maybe", proto.BootstrapStep{}, false},
		{"", proto.BootstrapStep{}, false},
	}

	for _, tc := range cases {
		got, ok := ParseStep(tc.line)
		if ok != tc.parsed {
			t.Errorf("%q parsed = %v, want %v", tc.line, ok, tc.parsed)
			continue
		}
		if ok && got != tc.want {
			t.Errorf("%q = %+v, want %+v", tc.line, got, tc.want)
		}
	}
}

// The hub sends four fixed names, and this is what makes that a property of
// the protocol rather than of the sender: these files are written as root, by
// a machine that trusts the hub completely.
//
// The first version of this test asserted nothing -- it passed with the
// defence deleted, because it only checked that /etc/cron.d/x did not appear
// on the machine running the test, which on Windows it never would. This one
// looks at where the file actually landed.
func TestWriteBootstrapRefusesAPathForAName(t *testing.T) {
	for _, name := range []string{
		"../../../etc/cron.d/x",
		"/etc/passwd",
		"..",
		"redroid/../../escape",
		// The one that would quietly work: ../x from inside redroid/ is still
		// inside the temp directory, so os.WriteFile has somewhere to put it.
		"../beside-redroid",
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			err := writeBootstrapTo(dir, proto.HostBootstrap{
				Script: "#!/bin/sh\n",
				Files:  []proto.BootstrapFile{{Name: name, Content: "x"}},
			})

			// Refused outright is fine. Written is fine only if it landed
			// inside the directory, under a bare name.
			if err != nil {
				return
			}
			written, globErr := filepath.Glob(filepath.Join(dir, "redroid", "*"))
			if globErr != nil {
				t.Fatal(globErr)
			}
			if len(written) != 1 {
				t.Fatalf("%q wrote %v — expected exactly one file inside the directory", name, written)
			}
			if got := filepath.Base(written[0]); got != filepath.Base(name) {
				t.Errorf("%q landed as %q", name, got)
			}
			// The whole point, and the case that matters: one `..` lands
			// beside the redroid directory rather than inside it, and that
			// write *succeeds* — so a test that only watches for an error, or
			// for /etc, passes with the defence deleted.
			escaped := filepath.Join(dir, filepath.Base(name))
			if _, statErr := os.Stat(escaped); statErr == nil {
				t.Errorf("%q escaped the redroid directory to %s", name, escaped)
			}
		})
	}
}

func TestWriteBootstrapNeedsAScript(t *testing.T) {
	if err := writeBootstrapTo(t.TempDir(), proto.HostBootstrap{}); err == nil {
		t.Fatal("an empty script should be refused")
	}
}

// The agent runs this script from inside the very service the script's last
// stage restarts, with no binary beside it. Both of those are fatal without
// the skip, and neither shows up as a compile error — so they are asserted.
func TestBootstrapEnvSkipsTheAgentStage(t *testing.T) {
	env := bootstrapEnv("magnemite/redroid:2")

	var image, skip bool
	for _, entry := range env {
		switch entry {
		case "MAGNEMITE_IMAGE=magnemite/redroid:2":
			image = true
		case "MAGNEMITE_SKIP_AGENT=1":
			skip = true
		}
		// Nothing about the machine's identity travels: it has its own, and
		// the script keeps it.
		for _, forbidden := range []string{"MAGNEMITE_TOKEN", "MAGNEMITE_SERIAL", "MAGNEMITE_SERVER"} {
			if strings.HasPrefix(entry, forbidden+"=") {
				t.Errorf("%s must not be sent to a re-run", forbidden)
			}
		}
	}
	if !image {
		t.Error("the image tag is what a re-run is usually for")
	}
	if !skip {
		t.Fatal("without MAGNEMITE_SKIP_AGENT the script dies at the agent stage, or kills the agent running it")
	}

	// And the one the image build needs. Absent, the script falls back to a
	// relative path that is not there, and the copy into the build context
	// kills the run two steps before the build -- on exactly the re-run an
	// image bump needs, and only on that one, so nothing else would catch it.
	var agentBin string
	for _, entry := range env {
		if rest, found := strings.CutPrefix(entry, "AGENT_BIN="); found {
			agentBin = rest
		}
	}
	if agentBin == "" {
		t.Fatal("AGENT_BIN is what the image build copies into its context")
	}
	if !filepath.IsAbs(agentBin) {
		t.Errorf("AGENT_BIN %q must be absolute: the script runs from its own directory", agentBin)
	}
}
