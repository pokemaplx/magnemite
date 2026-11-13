package host

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"magnemite/agent/internal/proto"
)

// Converger brings a machine's containers in line with a rendered compose file.
//
// An interface so -fake-docker can stand in for it: the file write, its sha256
// read-back, the batching and the result are all real in fake mode, and only
// the `docker compose` call is stubbed.
type Converger interface {
	Converge(ctx context.Context, req proto.HostConverge) proto.HostConvergeResult
}

// Capped here rather than at the hub, because this is where the bytes are. A
// frame is 1 MB and the column it lands in is 64 KB on MariaDB, so an uncapped
// cold image build would close the socket or fail the insert -- and either way
// the hub would never record the hash and would converge forever.
const maxOutputChars = 8_000

// clampOutput keeps the head and the tail. Both ends matter and the middle
// rarely does: docker names what it is doing first and why it failed last, so a
// plain truncation keeps the half nobody reads.
func clampOutput(text string) string {
	if len(text) <= maxOutputChars {
		return text
	}
	half := (maxOutputChars - 40) / 2
	dropped := len(text) - half*2
	return fmt.Sprintf("%s\n… %d characters dropped …\n%s", text[:half], dropped, text[len(text)-half:])
}

// Converge writes the file, then brings the services up in waves.
func (d *Docker) Converge(ctx context.Context, req proto.HostConverge) proto.HostConvergeResult {
	result := proto.HostConvergeResult{
		Type:      "host_converge_result",
		RequestID: req.RequestID,
	}

	path, sum, err := writeCompose(req.Dir, req.Compose)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	// Reported even when the converge below fails: the file *is* on the machine
	// at this point, and saying otherwise would have the hub send the same
	// bytes again on every reconnect.
	result.ComposeSha256 = sum

	services, err := composeServices(req.Compose)
	if err != nil {
		result.Error = err.Error()
		return result
	}

	var output strings.Builder
	batch := req.BatchSize
	if batch < 1 {
		batch = 1
	}

	// Named services in waves, so N Androids do not all hit peak memory at
	// once. `docker compose up` has no stagger of its own, and ten coming up
	// together on sixteen cores is the OOM the sizing advice warns about.
	for start := 0; start < len(services); start += batch {
		end := start + batch
		if end > len(services) {
			end = len(services)
		}
		args := []string{"compose", "-p", req.Project, "-f", path, "up", "-d"}
		args = append(args, services[start:end]...)
		out, runErr := d.run(ctx, applyTimeout, args...)
		output.WriteString(out)
		if runErr != nil {
			result.Output = clampOutput(output.String())
			result.Error = runErr.Error()
			return result
		}
	}

	// Orphans last, and only once the machine has converged before. A machine
	// running the hand-written compose file has containers holding real device
	// identities, and removing them because the hub's file does not name them
	// would drop every box on it.
	//
	// Also the only call that can act on a service the file does not name,
	// which is how a removed instance's container actually goes away.
	if req.RemoveOrphans {
		out, runErr := d.run(ctx, applyTimeout,
			"compose", "-p", req.Project, "-f", path, "up", "-d", "--remove-orphans")
		output.WriteString(out)
		if runErr != nil {
			result.Output = clampOutput(output.String())
			result.Error = runErr.Error()
			return result
		}
	}

	result.Ok = true
	result.Output = clampOutput(output.String())
	return result
}

// writeCompose puts the file in place atomically and returns the sha256 read
// back off disk.
//
// Read back rather than computed from what was handed in, for the reason the
// agent already reads a written MITM config back: the hash has to say what is
// on the machine, not what the hub meant. Hashing the input would only ever
// prove the hub was consistent with itself.
func writeCompose(dir, content string) (path string, sum string, err error) {
	if dir == "" {
		return "", "", fmt.Errorf("no compose directory")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	path = filepath.Join(dir, "docker-compose.yml")

	// Temp-then-rename, so a machine losing power mid-write never comes back
	// with a half-written file that compose would then act on.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return "", "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return "", "", err
	}

	onDisk, err := os.ReadFile(path)
	if err != nil {
		return "", "", err
	}
	digest := sha256.Sum256(onDisk)
	return path, hex.EncodeToString(digest[:]), nil
}

// composeServices lists the service names in the rendered file.
//
// Parsed with string handling rather than a YAML dependency, which is only
// honest because the input is not arbitrary YAML: the hub renders it, every
// service key sits at exactly one indent level under `services:`, and the
// alternative is a parser in the agent for a file it wrote itself.
//
// Returned sorted, so the waves below are deterministic — a machine that
// converged in a different order each time would be impossible to reason about
// from the output alone.
func composeServices(compose string) ([]string, error) {
	var names []string
	inServices := false

	for _, raw := range strings.Split(compose, "\n") {
		line := strings.TrimRight(raw, " \t\r")
		if line == "" || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}

		indent := len(line) - len(strings.TrimLeft(line, " "))
		if indent == 0 {
			// A new top-level key ends the services block.
			inServices = strings.HasPrefix(line, "services:")
			continue
		}
		if !inServices || indent != 2 {
			continue
		}

		name, _, found := strings.Cut(strings.TrimSpace(line), ":")
		if !found || name == "" {
			continue
		}
		names = append(names, name)
	}

	if len(names) == 0 {
		// Not an error. A machine drained to zero instances is a legitimate
		// desired state, and the orphan pass below is what actually removes
		// the containers.
		return nil, nil
	}
	sort.Strings(names)
	return names, nil
}
