package sys

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// skipOnWindows guards the two cases that rotate or truncate a file while the
// follow still holds it open.
//
// Both are ordinary on the platform the agent actually runs on, and neither is
// possible on Windows: an open handle blocks the rename and the truncate, so
// the test fails on the setup rather than on the behaviour it is about. The
// Windows build of the agent exists for the fake fleet, not for a box, so
// there is nothing here that Windows needs to be right about.
func skipOnWindows(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("rotating or truncating an open file is POSIX-only; the agent targets Linux/Android")
	}
}

// readLines pulls lines off the stream until it has want of them, or gives up.
// The follow polls once a second, so the deadline has to be generous.
func readLines(t *testing.T, scanner *bufio.Scanner, want int, deadline time.Duration) []string {
	t.Helper()

	lines := make([]string, 0, want)
	done := make(chan struct{})

	go func() {
		defer close(done)
		for len(lines) < want && scanner.Scan() {
			lines = append(lines, scanner.Text())
		}
	}()

	select {
	case <-done:
	case <-time.After(deadline):
		t.Fatalf("timed out with %d of %d lines: %v", len(lines), want, lines)
	}
	return lines
}

func writeLines(t *testing.T, path string, format string, from, to int) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	for i := from; i < to; i++ {
		if _, err := fmt.Fprintf(file, format+"\n", i); err != nil {
			t.Fatal(err)
		}
	}
}

// A follow starts on the tail of what is already there, not the whole file.
func TestFileStreamStartsAtTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	writeLines(t, path, "line %d", 0, followTailLines+50)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	reader, err := (&Android{}).FileStream(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()

	lines := readLines(t, bufio.NewScanner(reader), followTailLines, 5*time.Second)
	if len(lines) != followTailLines {
		t.Fatalf("got %d lines, want %d", len(lines), followTailLines)
	}
	// 250 lines written, 200 shown: the first one is line 50.
	if lines[0] != "line 50" {
		t.Errorf("first line is %q, want %q", lines[0], "line 50")
	}
	if lines[len(lines)-1] != "line 249" {
		t.Errorf("last line is %q, want %q", lines[len(lines)-1], "line 249")
	}
}

// The bug this replaced: the tail arrived and then nothing did.
func TestFileStreamFollowsAppends(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	if err := os.WriteFile(path, []byte("first\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	reader, err := (&Android{}).FileStream(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()

	scanner := bufio.NewScanner(reader)
	if got := readLines(t, scanner, 1, 5*time.Second); got[0] != "first" {
		t.Fatalf("got %q, want %q", got[0], "first")
	}

	writeLines(t, path, "appended %d", 0, 3)

	lines := readLines(t, scanner, 3, 10*time.Second)
	if lines[2] != "appended 2" {
		t.Errorf("got %q, want %q", lines[2], "appended 2")
	}
}

// A log the app rotates keeps streaming, rather than following a file nobody
// writes to any more.
func TestFileStreamSurvivesRotation(t *testing.T) {
	skipOnWindows(t)

	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	if err := os.WriteFile(path, []byte("before\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	reader, err := (&Android{}).FileStream(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()

	scanner := bufio.NewScanner(reader)
	readLines(t, scanner, 1, 5*time.Second)

	// Rotate the way a logger does: move the old one aside, start a new one.
	if err := os.Rename(path, filepath.Join(dir, "app.log.1")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("after rotation\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	lines := readLines(t, scanner, 1, 10*time.Second)
	if lines[0] != "after rotation" {
		t.Errorf("got %q, want %q", lines[0], "after rotation")
	}
}

// Truncation in place — the other way logs get reset — is not a reason to stop.
func TestFileStreamSurvivesTruncation(t *testing.T) {
	skipOnWindows(t)

	path := filepath.Join(t.TempDir(), "app.log")
	if err := os.WriteFile(path, []byte("before\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	reader, err := (&Android{}).FileStream(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()

	scanner := bufio.NewScanner(reader)
	readLines(t, scanner, 1, 5*time.Second)

	if err := os.WriteFile(path, []byte("after truncation\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	lines := readLines(t, scanner, 1, 10*time.Second)
	if lines[0] != "after truncation" {
		t.Errorf("got %q, want %q", lines[0], "after truncation")
	}
}

// Cancelling the context is how the agent stops a stream nobody is watching.
func TestFileStreamStopsOnCancel(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	if err := os.WriteFile(path, []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	reader, err := (&Android{}).FileStream(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()

	scanner := bufio.NewScanner(reader)
	readLines(t, scanner, 1, 5*time.Second)
	cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for scanner.Scan() {
		}
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the stream did not end after the context was cancelled")
	}
}

// A missing file fails at open, so the panel says so instead of sitting empty.
func TestFileStreamMissingFile(t *testing.T) {
	_, err := (&Android{}).FileStream(context.Background(), filepath.Join(t.TempDir(), "nope.log"))
	if err == nil {
		t.Fatal("expected an error for a file that does not exist")
	}
	if !strings.Contains(err.Error(), "nope.log") {
		t.Errorf("error does not name the file: %v", err)
	}
}
