package host

import (
	"context"
	"runtime"

	"magnemite/agent/internal/proto"
)

// Reporter assembles the host block for every hello and heartbeat.
//
// Its job is narrow on purpose: the machine's own readings — CPU, memory, swap,
// disk, load — already travel as a Device's metrics, so none of them are here.
// This is only what a box has no equivalent of.
type Reporter struct {
	Docker *Docker
	// Where the agent is measuring free space, so the report can say which
	// filesystem the disk numbers are about. A machine whose / has room while
	// docker's data root is full fails every install, and knowing which was
	// measured is the difference between that being obvious and being a
	// mystery.
	DiskPath string
}

func NewReporter(project, dir, diskPath string) *Reporter {
	return &Reporter{Docker: &Docker{Project: project, Dir: dir}, DiskPath: diskPath}
}

// Report never returns nil: a machine that can say nothing about docker still
// has an architecture and a kernel, and the empty docker version is itself the
// reading the hub acts on.
func (r *Reporter) Report(ctx context.Context) *proto.HostInfo {
	binder := BinderOk()
	info := &proto.HostInfo{
		Arch:    runtime.GOARCH,
		Kernel:  Kernel(),
		Project: r.Docker.Project,
		// A pointer, so "this agent did not check" stays different from
		// "checked, and the devices are missing" -- which is the one that
		// explains a machine whose containers will never come up.
		BinderOk: &binder,
	}

	info.DockerVersion = r.Docker.Version(ctx)
	if info.DockerVersion == "" {
		// No daemon: there is nothing to ask about containers, and an empty
		// list here would read as a machine with none rather than a machine
		// that could not be asked. Containers stays nil for that reason.
		return info
	}

	containers, err := r.Docker.Containers(ctx)
	if err != nil {
		return info
	}
	// Explicitly the empty slice rather than nil once docker has answered: a
	// machine with nothing on it is a real answer, and the one a freshly
	// bootstrapped host gives.
	if containers == nil {
		containers = []proto.ContainerStat{}
	}
	info.Containers = containers
	return info
}
