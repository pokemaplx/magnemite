package installer

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"magnemite/agent/internal/sys"
)

// shellSpy is a System that only answers Shell, which is all grantRoot calls.
// The embedded nil interface is deliberate: anything else this reaches would
// panic the test rather than pass it quietly.
type shellSpy struct {
	sys.System
	cmds []string
	out  string
	err  error
}

func (s *shellSpy) Shell(_ context.Context, cmd string) (string, error) {
	s.cmds = append(s.cmds, cmd)
	return s.out, s.err
}

type logSpy struct{ lines []string }

func (l *logSpy) Progress(string, int, string) {}
func (l *logSpy) Log(level, message string)    { l.lines = append(l.lines, level+": "+message) }

func TestGrantRootOnlyRunsWhereTheHelperExists(t *testing.T) {
	// Restored, because it is package state: a later test in this package
	// would otherwise find it pointing into a temp directory that is gone.
	original, originalMarker := rootGrantHelper, redroidMarker
	t.Cleanup(func() { rootGrantHelper, redroidMarker = original, originalMarker })
	// Absent, so the "no helper" case below is a TV box rather than a stale
	// image. The stale-image case has a test of its own.
	redroidMarker = filepath.Join(t.TempDir(), "no-marker")

	helper := filepath.Join(t.TempDir(), "magnemite-root-grant")
	if err := os.WriteFile(helper, []byte("#!/system/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name    string
		path    string
		pkg     string
		out     string
		err     error
		wantRun bool
	}{
		{
			// Every piece of hardware. A Magisk module install ships no such
			// file, and running a shell there on every install would be a
			// cost paid by boxes this cannot help.
			name: "no helper, as on a TV box", path: filepath.Join(t.TempDir(), "absent"),
			pkg: "com.pokemod.aegis", wantRun: false,
		},
		{
			name: "helper present", path: helper,
			pkg: "com.pokemod.aegis", out: "granted root to com.pokemod.aegis (uid 10119)", wantRun: true,
		},
		{
			// A job with no package name cannot name one to the helper, and
			// the helper exits 2 on that — better not to ask.
			name: "no package", path: helper, pkg: "", wantRun: false,
		},
		{
			// The app is installed and its config is written by now. Failing
			// the job would retry a 170 MB download over a policy row.
			name: "helper fails", path: helper, pkg: "com.pokemod.aegis",
			out: "no magisk on this box", err: errors.New("exit 1"), wantRun: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rootGrantHelper = tc.path
			spy := &shellSpy{out: tc.out, err: tc.err}
			logs := &logSpy{}
			(&Installer{Sys: spy}).grantRoot(tc.pkg, logs)

			if got := len(spy.cmds) > 0; got != tc.wantRun {
				t.Fatalf("shell run = %v, want %v (cmds %v)", got, tc.wantRun, spy.cmds)
			}
			if !tc.wantRun {
				return
			}
			if !strings.Contains(spy.cmds[0], tc.path) {
				t.Errorf("command %q does not run the helper", spy.cmds[0])
			}
			// Quoted, because it reaches `sh -c`.
			if !strings.Contains(spy.cmds[0], "'"+tc.pkg+"'") {
				t.Errorf("command %q does not pass the package quoted", spy.cmds[0])
			}
			if len(logs.lines) != 1 {
				t.Fatalf("want one log line, got %v", logs.lines)
			}
			if tc.err != nil && !strings.HasPrefix(strings.ToLower(logs.lines[0]), "warn") {
				t.Errorf("a failure should warn, got %q", logs.lines[0])
			}
		})
	}
}

// A container whose image predates the helper has just lost its scanner's
// root, and the job log is the only place that can say so. Hardware in the
// same position is silent on purpose, which is what the marker separates.
func TestGrantRootNamesAStaleRedroidImage(t *testing.T) {
	original, originalMarker := rootGrantHelper, redroidMarker
	t.Cleanup(func() { rootGrantHelper, redroidMarker = original, originalMarker })

	dir := t.TempDir()
	marker := filepath.Join(dir, "magnemite-start.sh")
	if err := os.WriteFile(marker, []byte("#!/system/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	rootGrantHelper = filepath.Join(dir, "absent")
	redroidMarker = marker

	spy := &shellSpy{}
	logs := &logSpy{}
	(&Installer{Sys: spy}).grantRoot("com.pokemod.aegis", logs)

	if len(spy.cmds) != 0 {
		t.Fatalf("nothing to run, but ran %v", spy.cmds)
	}
	if len(logs.lines) != 1 || !strings.HasPrefix(strings.ToLower(logs.lines[0]), "warn") {
		t.Fatalf("want one warning, got %v", logs.lines)
	}
	if !strings.Contains(logs.lines[0], "older than this agent") {
		t.Errorf("the warning does not say why: %q", logs.lines[0])
	}
}
