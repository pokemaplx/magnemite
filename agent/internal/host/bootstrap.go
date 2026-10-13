package host

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"magnemite/agent/internal/proto"
)

// Where a re-run writes what it was sent.
//
// Not /tmp, which several distributions clear on boot and which is exactly
// where the provisioning copies went: a machine that rebooted since has no
// redroid/ directory there, and the image step quietly does nothing. Beside
// the script's own home, which the bootstrap already owns and already keeps
// its copy of itself in.
const bootstrapDir = "/usr/local/lib/magnemite/bootstrap"

// How much of a failed run is worth sending back.
//
// The same reasoning the converge output follows: a frame is 1 MB and the
// column it lands in is 64 KB on MariaDB, so a cold image build's output has
// to be cut somewhere, and the end is the part that says what happened.
const maxBootstrapError = 8000

// Bootstrapper runs the provisioning script again, on a machine already up.
//
// One at a time, because two apt transactions are one broken dpkg and because
// the second would be doing the first's work anyway.
type Bootstrapper struct {
	mu      sync.Mutex
	running bool
}

// Run writes what the hub sent and executes it.
//
// The files matter as much as the script. The image step looks for `./redroid`
// relative to its working directory, so sending the script alone would re-run
// everything *except* the image build — which is the one thing a re-run is
// usually for.
func (b *Bootstrapper) Run(ctx context.Context, req proto.HostBootstrap) proto.HostBootstrapResult {
	result := proto.HostBootstrapResult{
		Type:      "host_bootstrap_result",
		RequestID: req.RequestID,
		// Explicitly empty rather than nil: a nil slice is JSON null, and the
		// hub's schema takes an array.
		Steps: []proto.BootstrapStep{},
	}

	b.mu.Lock()
	if b.running {
		b.mu.Unlock()
		result.Error = "a bootstrap is already running on this machine"
		return result
	}
	b.running = true
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		b.running = false
		b.mu.Unlock()
	}()

	if err := writeBootstrapTo(bootstrapDir, req); err != nil {
		result.Error = err.Error()
		return result
	}

	seconds := req.TimeoutSeconds
	if seconds <= 0 {
		seconds = 1800
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "sh", "./bootstrap.sh")
	cmd.Dir = bootstrapDir
	cmd.Env = append(os.Environ(), bootstrapEnv(req.Image)...)

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
	// SSH stream for the hub to read -- but it is the same script and the same
	// markers, so a run that fails still says which stage and why.
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		if step, ok := ParseStep(scanner.Text()); ok {
			result.Steps = append(result.Steps, step)
		}
	}

	werr := cmd.Wait()
	if werr != nil {
		// The script's own `die` writes the reason to stderr, and that is the
		// line worth having -- the exit status alone says nothing.
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = werr.Error()
		}
		result.Error = clamp(detail, maxBootstrapError)
		return result
	}

	result.Ok = true
	return result
}

// bootstrapEnv is what the script is given, and the second half of it is what
// makes running this from the agent safe at all.
//
// MAGNEMITE_IMAGE is the tag to build. Deliberately not the server, the serial
// or a token: the machine's /etc/magnemite/host.json already holds those, the
// script keeps an existing one, and sending them again would hand a credential
// to a machine that does not need it.
//
// MAGNEMITE_SKIP_AGENT stops the script's last stage, which installs the agent
// binary and restarts its unit. Without it every re-run dies at that stage --
// there is no binary beside the script, because the agent updates itself -- and
// if one were there, the restart would stop the service this very process is
// running inside, killing the run before its result could be sent.
func bootstrapEnv(image string) []string {
	return []string{
		"MAGNEMITE_IMAGE=" + image,
		"MAGNEMITE_SKIP_AGENT=1",
		// Where the image build finds the binary to bake in.
		//
		// Nothing is sent: this process *is* that binary, it is the arm64
		// build the Dockerfile wants, and after a self-update it is newer than
		// the hub's copy. Without it the script falls back to
		// ./magnemite-agent, which is not there -- and the copy into the build
		// context is the line that then kills the run, two steps before the
		// build it was preparing for.
		"AGENT_BIN=" + agentBinary(),
	}
}

// agentBinary is this process's own path, resolved, or where the bootstrap
// installs it when that cannot be read.
func agentBinary() string {
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			return resolved
		}
		return exe
	}
	return "/usr/local/bin/magnemite-agent"
}

// writeBootstrapTo lays out the directory the script expects to be run from.
//
// The directory is a parameter rather than the constant so a test can watch
// what this does with a name it was not expecting.
func writeBootstrapTo(dir string, req proto.HostBootstrap) error {
	if strings.TrimSpace(req.Script) == "" {
		return fmt.Errorf("no bootstrap script was sent")
	}
	if err := os.MkdirAll(filepath.Join(dir, "redroid"), 0o755); err != nil {
		return fmt.Errorf("could not make %s: %w", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bootstrap.sh"), []byte(req.Script), 0o755); err != nil {
		return fmt.Errorf("could not write the script: %w", err)
	}

	for _, file := range req.Files {
		// A name and nothing else: these are written as root, and a `..` or a
		// leading slash in one would put the hub's file anywhere on the
		// machine. The hub sends four fixed names; this is what makes that a
		// property of the protocol rather than of the sender.
		name := filepath.Base(file.Name)
		if name == "." || name == ".." || name == string(filepath.Separator) {
			return fmt.Errorf("refusing a file called %q", file.Name)
		}
		mode := os.FileMode(0o644)
		if parsed, err := strconv.ParseUint(file.Mode, 8, 32); err == nil && parsed != 0 {
			mode = os.FileMode(parsed)
		}
		path := filepath.Join(dir, "redroid", name)
		if err := os.WriteFile(path, []byte(file.Content), mode); err != nil {
			return fmt.Errorf("could not write %s: %w", name, err)
		}
		// WriteFile only applies the mode when it creates the file, and a
		// re-run is writing over the last one.
		if err := os.Chmod(path, mode); err != nil {
			return fmt.Errorf("could not chmod %s: %w", name, err)
		}
	}
	return nil
}

// ParseStep reads one `::step <name> <ok|warn|fail> [detail]` line.
//
// A warning is not a failure, which is the whole reason the script has three
// words rather than two: swap that could not be created leaves a machine that
// runs, and calling that a failure would stop a re-run that was going to work.
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

func clamp(text string, max int) string {
	if len(text) <= max {
		return text
	}
	return "… " + text[len(text)-max:]
}
