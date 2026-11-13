// Package host is the half of the agent that only a machine running Redroid
// containers has: what docker is, what containers it is holding, and bringing
// the set of them in line with what the hub asked for.
//
// Everything else a machine reports — its CPU, memory, swap, disk, load — is a
// Device's and goes through the ordinary metrics path, because a host is a
// Device. This package is deliberately small for that reason.
package host

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"time"

	"magnemite/agent/internal/proto"
)

// Docker drives the real thing by shelling out to the CLI.
//
// The CLI rather than the API socket, because the compose project is the unit
// of work here: `docker compose` already knows how to converge a file, bring up
// what is missing, remove what is no longer named and leave the rest alone.
// Driving the API would mean reimplementing those semantics, and getting
// `--remove-orphans` subtly wrong is how a machine loses boxes.
type Docker struct {
	// Project and dir are the hub's, so everything rendered lives under one
	// compose project. That is what makes --remove-orphans safe: it can only
	// ever remove containers Magnemite put there.
	Project string
	Dir     string
}

// Timeouts. Generous, because the operations behind them genuinely are: a cold
// image pull on a thin uplink is minutes, and ten Androids coming up is more.
const (
	queryTimeout = 30 * time.Second
	applyTimeout = 30 * time.Minute
)

func (d *Docker) run(ctx context.Context, timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	return string(out), err
}

// Version is what `docker --version` says, or empty when docker is not there.
//
// Empty is the signal the hub reads as the daemon being unreachable, and it is
// worth separating from "the agent is gone": a machine whose docker died still
// heartbeats, and the two faults have different fixes.
func (d *Docker) Version(ctx context.Context) string {
	out, err := d.run(ctx, queryTimeout, "version", "--format", "{{.Server.Version}}")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// composePS is one line of `docker compose ps --format json`.
//
// Only the fields that are read are declared; compose adds more between
// versions and decoding into a narrow struct ignores them, which is what keeps
// this from breaking on an upgrade.
type composePS struct {
	Name    string `json:"Name"`
	Service string `json:"Service"`
	State   string `json:"State"`
	Image   string `json:"Image"`
}

// Containers is every container under the project, running or not.
//
// Two calls, because neither alone is enough: `compose ps` knows the project
// and the state, and `inspect` is the only source for the restart count, the
// applied memory limit and the serial the container was actually started with.
// The serial is the important one — it is what matches a container to an
// instance row, and reading it back rather than assuming it is what makes
// adopting a hand-written compose file possible at all.
func (d *Docker) Containers(ctx context.Context) ([]proto.ContainerStat, error) {
	out, err := d.run(ctx, queryTimeout, "compose", "-p", d.Project, "ps", "--all", "--format", "json")
	if err != nil {
		return nil, err
	}

	var names []composePS
	// Compose emits one JSON object per line in some versions and a single
	// array in others. Handling both is cheaper than pinning a version.
	trimmed := strings.TrimSpace(out)
	if strings.HasPrefix(trimmed, "[") {
		if err := json.Unmarshal([]byte(trimmed), &names); err != nil {
			return nil, err
		}
	} else {
		for _, line := range strings.Split(trimmed, "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			var row composePS
			if err := json.Unmarshal([]byte(line), &row); err != nil {
				continue
			}
			names = append(names, row)
		}
	}
	if len(names) == 0 {
		return nil, nil
	}

	stats := make([]proto.ContainerStat, 0, len(names))
	for _, row := range names {
		stat := proto.ContainerStat{Name: row.Name, State: row.State, Image: row.Image}
		d.inspect(ctx, row.Name, &stat)
		stats = append(stats, stat)
	}
	return stats, nil
}

// inspected is the shape of the one `docker inspect` template below.
type inspected struct {
	RestartCount *int     `json:"restartCount"`
	Memory       *uint64  `json:"memory"`
	Cmd          []string `json:"cmd"`
}

// inspect fills in what `compose ps` does not report. A failure is left as
// absent rather than defaulted: a restart count of zero and "docker would not
// say" are different answers, and only one of them means the container is
// healthy.
func (d *Docker) inspect(ctx context.Context, name string, stat *proto.ContainerStat) {
	const tmpl = `{"restartCount":{{.RestartCount}},"memory":{{.HostConfig.Memory}},"cmd":{{json .Config.Cmd}}}`
	out, err := d.run(ctx, queryTimeout, "inspect", "--format", tmpl, name)
	if err != nil {
		return
	}
	var got inspected
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &got); err != nil {
		return
	}

	stat.RestartCount = got.RestartCount
	// Docker reports an unlimited container as 0, which is not a limit of zero
	// bytes. Left absent so the hub can tell "no limit applied" from "docker
	// did not say" — and flag the first against what it asked for, because an
	// unlimited container reports the whole machine's RAM as its own.
	if got.Memory != nil && *got.Memory > 0 {
		stat.MemLimitBytes = got.Memory
	}
	stat.Serial = serialFromCmd(got.Cmd)
}

// serialFromCmd picks the serial out of the Android properties the container
// was started with.
//
// `ro.magnemite.serial` is the namespaced one the start script reads, and it
// wins; `ro.serialno` is what the hand-written compose file in this repo sets,
// and reading it too is what lets such a machine be adopted rather than having
// its containers treated as strangers.
func serialFromCmd(cmd []string) string {
	var fallback string
	for _, arg := range cmd {
		key, value, found := strings.Cut(arg, "=")
		if !found || value == "" {
			continue
		}
		switch strings.TrimSpace(key) {
		case "ro.magnemite.serial":
			return value
		case "ro.serialno":
			fallback = value
		}
	}
	return fallback
}

// BinderOk reports whether the devices Android asks for are actually present.
//
// The outcome rather than the step: Redroid's own documentation disagrees with
// itself about whether a modern kernel needs the module at all, so what gets
// checked is whether a container could come up, not whether a modprobe ran.
func BinderOk() bool {
	for _, path := range []string{"/dev/binder", "/dev/binderfs", "/dev/binderfs/binder"} {
		if fileExists(path) {
			return true
		}
	}
	return strings.Contains(readFile("/proc/filesystems"), "binder")
}

// Arch and Kernel are read rather than compiled in, because the kernel is the
// one that moves: `linux-modules-extra` is per kernel version, so an upgrade
// that installs a new one leaves binder behind and every container fails to
// come up after the reboot.
func Kernel() string {
	return strings.TrimSpace(readFile("/proc/sys/kernel/osrelease"))
}
