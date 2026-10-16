package box

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"magnemite/agent/internal/proto"
)

func TestParseFact(t *testing.T) {
	cases := []struct {
		line   string
		want   proto.BoxFact
		parsed bool
	}{
		// The reason the format is three fields and a tail rather than
		// key=value pairs. This is what a Chromecast actually reports.
		{
			"::fact 192.168.1.10:5555 model Chromecast with Google TV",
			proto.BoxFact{Address: "192.168.1.10:5555", Key: "model", Value: "Chromecast with Google TV"},
			true,
		},
		// A fact with no value is still a fact: an empty ro.serialno is what
		// makes the hub mint a serial, so dropping it would turn a box that
		// needs an override into one that silently does not get one.
		{
			"::fact 192.168.1.10:5555 serial",
			proto.BoxFact{Address: "192.168.1.10:5555", Key: "serial"},
			true,
		},
		// Run-level rather than about any box. Today that is this machine's
		// own adb public key.
		{
			"::fact - adbPublicKey QAAAAL== user@host",
			proto.BoxFact{Address: "-", Key: "adbPublicKey", Value: "QAAAAL== user@host"},
			true,
		},
		// Everything else on stdout is adb being noisy.
		{"* daemon started successfully", proto.BoxFact{}, false},
		{"::step probe ok 4/8", proto.BoxFact{}, false},
		{"::fact", proto.BoxFact{}, false},
		{"::fact 192.168.1.10:5555", proto.BoxFact{}, false},
		{"", proto.BoxFact{}, false},
	}

	for _, tc := range cases {
		got, ok := ParseFact(tc.line)
		if ok != tc.parsed {
			t.Errorf("%q parsed = %v, want %v", tc.line, ok, tc.parsed)
			continue
		}
		if ok && got != tc.want {
			t.Errorf("%q = %+v, want %+v", tc.line, got, tc.want)
		}
	}
}

func TestParseStepKeepsTheAddressInTheName(t *testing.T) {
	// How one run's output is split back across the rows it belongs to: the
	// hub splits on the last slash.
	step, ok := ParseStep("::step 192.168.1.10:5555/install fail magisk: not found")
	if !ok {
		t.Fatal("did not parse")
	}
	if step.Name != "192.168.1.10:5555/install" || step.Ok || step.Detail != "magisk: not found" {
		t.Errorf("got %+v", step)
	}
}

func TestWriteScriptRefusesAnEmptyOrUnknownRequest(t *testing.T) {
	dir := t.TempDir()

	if _, err := writeScript(dir, proto.BoxAdb{Mode: "probe"}); err == nil {
		t.Error("accepted a request with no script")
	}
	// A mode the script does not know would fall through its final case and
	// `die`, which reads as a failed run rather than a refused one.
	if _, err := writeScript(dir, proto.BoxAdb{Mode: "wipe", Script: "echo hi"}); err == nil {
		t.Error("accepted an unknown mode")
	}
	if _, err := writeScript(dir, proto.BoxAdb{Mode: "enroll", Script: "echo hi"}); err != nil {
		t.Errorf("refused a good request: %v", err)
	}
}

func TestScriptEnvCarriesTargetsAsTabbedLines(t *testing.T) {
	env := scriptEnv(proto.BoxAdb{
		Mode:    "enroll",
		Targets: []proto.BoxTarget{{Address: "10.0.0.1:5555", Serial: "box-abc", Token: "tok1"}, {Address: "10.0.0.2:5555", Token: "tok2"}},
		Reboot:  false,
	}, "/tmp/m.zip", "/etc/magnemite/adb")

	find := func(prefix string) string {
		for _, e := range env {
			if strings.HasPrefix(e, prefix) {
				return strings.TrimPrefix(e, prefix)
			}
		}
		return "<missing>"
	}

	if got := find("MAGNEMITE_TARGETS="); got != "10.0.0.1:5555\tbox-abc\ttok1\n10.0.0.2:5555\t\ttok2" {
		t.Errorf("targets = %q", got)
	}
	// An empty serial has to survive as an empty *field*, not a missing one:
	// the script reads the token with `cut -f3`, so a dropped tab would hand
	// the box its own serial as a token.
	if got := find("MAGNEMITE_REBOOT="); got != "0" {
		t.Errorf("reboot = %q, want 0", got)
	}
	if got := find("MAGNEMITE_ZIP="); got != "/tmp/m.zip" {
		t.Errorf("zip = %q", got)
	}
}

// Runs the real script through the real runner, with a stub standing in for
// adb.
//
// This is the cheapest test there is of the parts most likely to break: the
// batching, the per-box step names, and the fact that a box which fails never
// gets a config written to it. It needs a POSIX shell, so it is skipped on
// Windows and runs in CI and in the golang container, which is where
// `make agent-test` puts it.
func TestRunProbesThroughTheRealScript(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs a POSIX shell and a PATH that can shadow adb")
	}

	_, thisFile, _, _ := runtime.Caller(0)
	script, err := os.ReadFile(filepath.Join(filepath.Dir(thisFile), "..", "..", "box", "adb-enroll.sh"))
	if err != nil {
		t.Skipf("no script to run: %v", err)
	}

	bin := t.TempDir()
	stub := `#!/bin/sh
case "$1" in
start-server|kill-server|disconnect) exit 0 ;;
keygen) printf 'FAKEKEY\n' > "$2.pub"; printf 'priv\n' > "$2"; exit 0 ;;
connect)
	case "$2" in
	*.99:*) echo "failed to connect to $2"; exit 1 ;;
	*) echo "connected to $2"; exit 0 ;;
	esac ;;
esac
addr=$2; shift 2
case "$1" in
get-state)
	case "$addr" in
	*.98:*) echo "error: device unauthorized" >&2; exit 1 ;;
	*) echo device ;;
	esac ;;
shell)
	case "$2" in
	*getprop*) printf 'SERIAL%s\n\nBox With Spaces\nAcme\narm64-v8a\n30\n' "$addr" ;;
	*'id -u'*) echo 0 ;;
	*'test -f'*) echo no ;;
	esac ;;
esac
exit 0
`
	if err := os.WriteFile(filepath.Join(bin, "adb"), []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	// Keep the run out of /usr/local and out of the machine's real key store.
	t.Setenv("HOME", t.TempDir())

	dir := t.TempDir()
	path, err := writeScript(dir, proto.BoxAdb{Mode: "probe", Script: string(script)})
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(path) != "adb-enroll.sh" {
		t.Fatalf("script landed at %s", path)
	}

	out := runScript(context.Background(), dir, proto.BoxAdb{
		Mode:           "probe",
		Addresses:      []string{"10.0.0.1", "10.0.0.98", "10.0.0.99"},
		TimeoutSeconds: 120,
	}, "", filepath.Join(t.TempDir(), "adbhome"))

	states := map[string]string{}
	for _, f := range out.Facts {
		if f.Key == "state" {
			states[f.Address] = f.Value
		}
	}
	for addr, want := range map[string]string{
		"10.0.0.1:5555":  "device",
		"10.0.0.98:5555": "unauthorized",
		"10.0.0.99:5555": "offline",
	} {
		if states[addr] != want {
			t.Errorf("%s state = %q, want %q", addr, states[addr], want)
		}
	}

	// The spaces have to survive, which is the whole reason for the format.
	var model string
	for _, f := range out.Facts {
		if f.Address == "10.0.0.1:5555" && f.Key == "model" {
			model = f.Value
		}
	}
	if model != "Box With Spaces" {
		t.Errorf("model = %q", model)
	}

	if !out.Ok {
		t.Errorf("probe failed: %s", out.Error)
	}
}
