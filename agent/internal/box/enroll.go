// Package box runs adb against hardware boxes on a machine's own LAN, on the
// hub's behalf.
//
// It exists because of the invariant the rest of Magnemite is built on: boxes
// live behind NAT in other people's homes and nothing may reach *them*. A hub
// on a VPS therefore cannot open 192.168.1.10:5555, however much it would
// like to. A machine already on that LAN can, over the socket it holds
// outwards — so the hub asks it to, and this is the half that answers.
//
// The script is the hub's, sent with the request. Everything here is the
// plumbing around it: one run at a time, a module zip fetched with this
// machine's own token, and the script's own output parsed back into
// something the hub can put on a row.
package box

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"magnemite/agent/internal/fetch"
	"magnemite/agent/internal/proto"
)

// Where the script and the module land.
//
// Not /tmp, for the reason the bootstrap gives: several distributions clear
// it on boot, and a machine that rebooted mid-batch would find nothing where
// it left it. Beside the bootstrap's own home, which the machine already owns.
const workDir = "/usr/local/lib/magnemite/box"

// Where this machine keeps its adb identity.
//
// Its own, never the hub's. An adb key a box has trusted is, combined with
// su, a root shell on that box — so a fleet-wide key sitting on a relay would
// make one compromised machine root on every box that ever trusted the hub.
// A machine in somebody's living room is a perfectly ordinary relay, which is
// what makes that unacceptable rather than merely untidy.
const adbHome = "/etc/magnemite/adb"

// How much of a failed run is worth sending back. The same ceiling the
// bootstrap uses, for the same reasons: a 1 MB frame and a 64 KB column.
const maxError = 8000

// Enroller runs the hub's adb script.
//
// One at a time. adb's server is global to the machine and its device list is
// shared, so two runs would see each other's boxes — and an enrollment acting
// on a box another run connected is not a race anybody wants to debug.
type Enroller struct {
	mu      sync.Mutex
	running bool
}

// Run writes what the hub sent, executes it, and reports what it said.
func (e *Enroller) Run(ctx context.Context, req proto.BoxAdb, deviceToken string) proto.BoxAdbResult {
	result := proto.BoxAdbResult{
		Type:      "box_adb_result",
		RequestID: req.RequestID,
		// Explicitly empty rather than nil: a nil slice is JSON null and the
		// hub's schema takes arrays.
		Steps: []proto.BootstrapStep{},
		Facts: []proto.BoxFact{},
	}

	e.mu.Lock()
	if e.running {
		e.mu.Unlock()
		result.Error = "adb is already running on this machine"
		return result
	}
	e.running = true
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		e.running = false
		e.mu.Unlock()
	}()

	if _, err := exec.LookPath("adb"); err != nil {
		result.Error = "adb is not installed on this machine — re-run its bootstrap to install it"
		return result
	}

	if err := os.MkdirAll(adbHome, 0o700); err != nil {
		result.Error = fmt.Sprintf("could not make %s: %v", adbHome, err)
		return result
	}
	if _, err := writeScript(workDir, req); err != nil {
		result.Error = err.Error()
		return result
	}

	seconds := req.TimeoutSeconds
	if seconds <= 0 {
		seconds = 1800
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
	defer cancel()

	zip := ""
	if req.Mode == "enroll" {
		if req.ModuleURL == "" || req.ModuleSHA256 == "" {
			result.Error = "no module was offered, so there is nothing to install"
			return result
		}
		zip = filepath.Join(workDir, "magnemite-module.zip")
		// Fetched rather than sent: ~5 MB of binary through a JSON string
		// would be base64 on the wire and held twice in memory, with no
		// checksum. This machine is an approved device with a token, and
		// /files/* is exactly the path its own updates come down.
		if err := fetch.Verified(ctx, req.ModuleURL, deviceToken, req.ModuleSHA256, zip, 0o600); err != nil {
			result.Error = fmt.Sprintf("could not fetch the module: %v", err)
			return result
		}
	}

	return runScript(ctx, workDir, req, zip, adbHome)
}

// runScript executes what writeScript laid out and parses what it says.
//
// Split from Run so a test can drive the real script against a stubbed adb
// without needing /etc, a module to fetch, or the one-at-a-time guard. The
// directories are parameters for the same reason.
func runScript(ctx context.Context, dir string, req proto.BoxAdb, zip, adbHomeDir string) proto.BoxAdbResult {
	result := proto.BoxAdbResult{
		Type:      "box_adb_result",
		RequestID: req.RequestID,
		Steps:     []proto.BootstrapStep{},
		Facts:     []proto.BoxFact{},
	}

	cmd := exec.CommandContext(ctx, "sh", "adb-enroll.sh")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), scriptEnv(req, zip, adbHomeDir)...)
	// Closed rather than inherited. `adb connect` forks a server that
	// outlives this command, and a daemon holding the agent's own stdin is
	// how a run ends up unkillable.
	cmd.Stdin = nil

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		result.Error = err.Error()
		return result
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		result.Error = err.Error()
		return result
	}

	// Parsed here rather than at the hub, because over this path there is no
	// stream for the hub to read -- but it is the same script and the same
	// markers, so a run that fails still says which box and why.
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		if step, ok := ParseStep(line); ok {
			result.Steps = append(result.Steps, step)
			continue
		}
		if fact, ok := ParseFact(line); ok {
			result.Facts = append(result.Facts, fact)
		}
	}

	if werr := cmd.Wait(); werr != nil {
		// The script's own `die` writes the reason to stderr, and that is the
		// line worth having -- an exit status alone says nothing.
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = werr.Error()
		}
		result.Error = clamp(detail, maxError)
		return result
	}

	result.Ok = true
	return result
}

// scriptEnv is what the script is given.
//
// Through the environment rather than argv, which is the same choice the hub
// makes locally and for the same reason: argv is world-readable through
// /proc/<pid>/cmdline, and the targets carry enrollment tokens.
func scriptEnv(req proto.BoxAdb, zip, adbHomeDir string) []string {
	targets := make([]string, 0, len(req.Targets))
	for _, t := range req.Targets {
		targets = append(targets, strings.Join([]string{t.Address, t.Serial, t.Token}, "\t"))
	}

	reboot := "1"
	if !req.Reboot {
		reboot = "0"
	}
	reprovision := "0"
	if req.Reprovision {
		reprovision = "1"
	}

	return []string{
		"MAGNEMITE_MODE=" + req.Mode,
		"MAGNEMITE_ADB_HOME=" + adbHomeDir,
		"MAGNEMITE_ADDRESSES=" + strings.Join(req.Addresses, "\n"),
		"MAGNEMITE_TARGETS=" + strings.Join(targets, "\n"),
		"MAGNEMITE_SERVER=" + req.ServerURL,
		"MAGNEMITE_ZIP=" + zip,
		"MAGNEMITE_REBOOT=" + reboot,
		"MAGNEMITE_REPROVISION=" + reprovision,
	}
}

// writeScript lays out the directory the script runs from.
//
// The directory is a parameter rather than the constant so a test can watch
// what this does with a name it was not expecting.
func writeScript(dir string, req proto.BoxAdb) (string, error) {
	if strings.TrimSpace(req.Script) == "" {
		return "", fmt.Errorf("no adb script was sent")
	}
	if req.Mode != "probe" && req.Mode != "enroll" {
		return "", fmt.Errorf("refusing an unknown mode %q", req.Mode)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("could not make %s: %w", dir, err)
	}
	// 0700 on the directory because the module zip and, briefly, nothing else
	// live here — but the script is run as root and the machine may have
	// other users.
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", fmt.Errorf("could not chmod %s: %w", dir, err)
	}
	path := filepath.Join(dir, "adb-enroll.sh")
	if err := os.WriteFile(path, []byte(req.Script), 0o700); err != nil {
		return "", fmt.Errorf("could not write the script: %w", err)
	}
	// WriteFile only applies the mode when it creates the file, and every run
	// after the first is writing over the last one.
	if err := os.Chmod(path, 0o700); err != nil {
		return "", fmt.Errorf("could not chmod the script: %w", err)
	}
	return path, nil
}

// ParseStep reads one `::step <name> <ok|warn|fail> [detail]` line.
//
// A copy of the host package's, deliberately: importing that one would tie
// the box path to the machine bootstrap's lifetime, and the marker format is
// part of the protocol rather than of either feature.
func ParseStep(line string) (proto.BootstrapStep, bool) {
	fields := strings.Fields(strings.TrimSpace(line))
	if len(fields) < 3 || fields[0] != "::step" {
		return proto.BootstrapStep{}, false
	}
	switch fields[2] {
	case "ok", "warn", "fail":
	default:
		return proto.BootstrapStep{}, false
	}
	step := proto.BootstrapStep{Name: fields[1], Ok: fields[2] != "fail"}
	if len(fields) > 3 {
		step.Detail = strings.Join(fields[3:], " ")
	}
	return step, true
}

// ParseFact reads one `::fact <address> <key> <value...>` line.
//
// The tail is joined rather than taken as one field, which is the whole point
// of the format: ro.product.model is routinely "Chromecast with Google TV",
// and a key=value encoding would have had to escape it.
//
// A fact with no value is still a fact — an empty ro.serialno is what makes
// the hub mint a serial, so dropping it as unparseable would turn a box that
// needs an override into one that silently does not get one.
func ParseFact(line string) (proto.BoxFact, bool) {
	fields := strings.Fields(strings.TrimSpace(line))
	if len(fields) < 3 || fields[0] != "::fact" {
		return proto.BoxFact{}, false
	}
	fact := proto.BoxFact{Address: fields[1], Key: fields[2]}
	if len(fields) > 3 {
		fact.Value = strings.Join(fields[3:], " ")
	}
	return fact, true
}

func clamp(text string, max int) string {
	if len(text) <= max {
		return text
	}
	return "… " + text[len(text)-max:]
}
