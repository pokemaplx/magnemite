package host

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"magnemite/agent/internal/proto"
)

const rendered = `name: magnemite-redroid

services:
  box-02:
    image: magnemite/redroid:1
    privileged: true
    command:
      - ro.magnemite.serial=rd-abc123-02
  box-01:
    image: magnemite/redroid:1
    command:
      - ro.magnemite.serial=rd-abc123-01

volumes:
  box-01-data:
`

func TestComposeServices(t *testing.T) {
	got, err := composeServices(rendered)
	if err != nil {
		t.Fatalf("composeServices() error = %v", err)
	}
	// Sorted, so the waves are deterministic -- a machine that converged in a
	// different order each time could not be reasoned about from the output.
	want := []string{"box-01", "box-02"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("composeServices() = %v, want %v", got, want)
	}

	// `volumes:` is a top-level key, not a service, and neither is anything
	// nested deeper than one level under services.
	for _, name := range got {
		if name == "volumes" || name == "image" || name == "command" {
			t.Errorf("composeServices() picked up %q", name)
		}
	}

	// Zero instances is a legitimate desired state -- a drained machine -- and
	// must not be an error.
	empty, err := composeServices("name: p\nservices:\n")
	if err != nil || len(empty) != 0 {
		t.Errorf("empty services = (%v, %v), want (nil, nil)", empty, err)
	}
}

func TestWriteComposeReadsBackTheHash(t *testing.T) {
	dir := t.TempDir()
	path, sum, err := writeCompose(dir, rendered)
	if err != nil {
		t.Fatalf("writeCompose() error = %v", err)
	}
	if path != filepath.Join(dir, "docker-compose.yml") {
		t.Errorf("path = %q", path)
	}
	onDisk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != rendered {
		t.Error("the file on disk is not what was written")
	}
	if len(sum) != 64 {
		t.Errorf("sha256 = %q, want 64 hex chars", sum)
	}

	// Writing again is idempotent and yields the same hash, which is what the
	// hub compares against to decide a converge is unnecessary.
	_, again, err := writeCompose(dir, rendered)
	if err != nil || again != sum {
		t.Errorf("second write = (%q, %v), want the same hash", again, err)
	}

	// No .tmp left behind, or the next write would trip over it.
	if _, err := os.Stat(path + ".tmp"); err == nil {
		t.Error("a .tmp file was left behind")
	}
}

func TestFakeConvergeIsRealExceptDocker(t *testing.T) {
	dir := t.TempDir()
	f := NewFakeReporter("magnemite-redroid", 0)

	got := f.Converge(context.Background(), proto.HostConverge{
		Type: "host_converge", RequestID: "r1",
		Project: "magnemite-redroid", Dir: dir, Compose: rendered, BatchSize: 2,
	})
	if !got.Ok {
		t.Fatalf("Converge() not ok: %s", got.Error)
	}
	if len(got.ComposeSha256) != 64 {
		t.Errorf("no hash read back: %q", got.ComposeSha256)
	}

	// The containers the hub asked for become the ones this machine reports,
	// which is what makes running/desired real in fake mode.
	report := f.Report(context.Background())
	if len(report.Containers) != 2 {
		t.Fatalf("containers after converge = %d, want 2", len(report.Containers))
	}
	// And each carries the serial out of the rendered file, so it matches its
	// instance row the way a real container does.
	serials := map[string]bool{}
	for _, c := range report.Containers {
		serials[c.Serial] = true
	}
	for _, want := range []string{"rd-abc123-01", "rd-abc123-02"} {
		if !serials[want] {
			t.Errorf("missing serial %q, got %v", want, serials)
		}
	}
}

func TestClampOutputKeepsBothEnds(t *testing.T) {
	long := strings.Repeat("a", 100) + strings.Repeat("b", maxOutputChars) + strings.Repeat("c", 100)
	got := clampOutput(long)
	if len(got) > maxOutputChars {
		t.Errorf("clamped length = %d, want <= %d", len(got), maxOutputChars)
	}
	// Docker names what it was doing first and why it failed last, so both
	// ends have to survive.
	if !strings.HasPrefix(got, "aaa") {
		t.Error("the head was dropped")
	}
	if !strings.HasSuffix(got, "ccc") {
		t.Error("the tail was dropped")
	}
	if !strings.Contains(got, "characters dropped") {
		t.Error("the clamp is silent about what it dropped")
	}
}
