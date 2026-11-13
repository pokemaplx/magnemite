package host

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"magnemite/agent/internal/proto"
)

// FakeReporter stands in for docker, and nothing else.
//
// Built on the same principle as the fake fleet, which is what makes either
// worth having: `-fake-root` stubs `pm`, `dumpsys` and `getprop` and nothing
// else, so the download, the sha256 check and the .apkm extraction are all
// real. Here the two docker calls are the only seam — enrollment, the socket,
// the welcome, the metrics, the sampling gate and the host block itself are the
// real code paths.
//
// It exists because the thing this feature manages needs an arm64 Linux host
// with a kernel module, and development happens on Windows. Without it, nothing
// above the protocol could be exercised at all until there was hardware.
type FakeReporter struct {
	project   string
	instances int

	mu         sync.Mutex
	containers []proto.ContainerStat
}

// NewFakeReporter starts with `instances` containers already running, as a
// machine that has been converged once would have.
func NewFakeReporter(project string, instances int) *FakeReporter {
	f := &FakeReporter{project: project, instances: instances}
	for i := 1; i <= instances; i++ {
		limit := uint64(4) * 1024 * 1024 * 1024
		restarts := 0
		f.containers = append(f.containers, proto.ContainerStat{
			Name:  fmt.Sprintf("%s-box-%02d", project, i),
			State: "running",
			// The serial the hub would have minted, in the shape the renderer
			// writes: this is what matches a container back to its instance
			// row, so a fake that got it wrong would exercise nothing.
			Serial:        fmt.Sprintf("rd-%s-%02d", fakeHostPrefix(), i),
			RestartCount:  &restarts,
			MemLimitBytes: &limit,
			Image:         "magnemite/redroid:1",
		})
	}
	return f
}

// fakeHostPrefix mirrors how the hub derives an instance serial from the host's
// id, so a fake machine's containers look like real ones. Taken from the
// environment, because the fleet script gives each fake host its own.
func fakeHostPrefix() string {
	if v := os.Getenv("MAGNEMITE_FAKE_HOST_PREFIX"); v != "" {
		return v
	}
	return "fakehost"
}

func (f *FakeReporter) Report(ctx context.Context) *proto.HostInfo {
	f.mu.Lock()
	containers := make([]proto.ContainerStat, len(f.containers))
	copy(containers, f.containers)
	f.mu.Unlock()

	binder := os.Getenv("MAGNEMITE_FAKE_NO_BINDER") == ""
	version := "27.3.1"
	// The fault worth being able to reproduce without a VPS: the agent is up
	// and the daemon is not, which is a different signal from the machine
	// going offline and has a different fix.
	if os.Getenv("MAGNEMITE_FAKE_DOCKER_DOWN") != "" {
		version = ""
		containers = nil
	}

	return &proto.HostInfo{
		Arch:          runtime.GOARCH,
		Kernel:        fakeKernel(),
		DockerVersion: version,
		BinderOk:      &binder,
		Project:       f.project,
		Containers:    containers,
	}
}

// fakeKernel is overridable so the kernel-upgrade trap can be rehearsed: the
// value moving is what a machine looks like after an apt upgrade that left
// linux-modules-extra behind, and pairing it with MAGNEMITE_FAKE_NO_BINDER is
// the whole failure.
func fakeKernel() string {
	if v := os.Getenv("MAGNEMITE_FAKE_KERNEL"); v != "" {
		return v
	}
	return "6.8.0-51-generic"
}

// SetContainerState is how a test or the fake fleet makes one instance look
// crash-looping or stopped, which is what a REDROID_INSTANCE_DOWN rule acts on.
func (f *FakeReporter) SetContainerState(index int, state string, restarts int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if index < 1 || index > len(f.containers) {
		return
	}
	f.containers[index-1].State = state
	f.containers[index-1].RestartCount = &restarts
}

// FakeInstancesFromEnv reads how many containers a fake machine should pretend
// to hold, so the fleet script can vary it per host.
func FakeInstancesFromEnv(def int) int {
	v := os.Getenv("MAGNEMITE_FAKE_INSTANCES")
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return def
	}
	return n
}

// Converge is the fake's half of a converge: everything except the docker call
// is the real path. The file is genuinely written, its sha256 genuinely read
// back off disk, and the service list genuinely parsed out of the rendered
// bytes -- so a renderer that emitted something compose could not read, or a
// hash the hub then disagreed with, still fails here.
func (f *FakeReporter) Converge(ctx context.Context, req proto.HostConverge) proto.HostConvergeResult {
	result := proto.HostConvergeResult{
		Type:      "host_converge_result",
		RequestID: req.RequestID,
	}

	_, sum, err := writeCompose(req.Dir, req.Compose)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.ComposeSha256 = sum

	services, err := composeServices(req.Compose)
	if err != nil {
		result.Error = err.Error()
		return result
	}

	if os.Getenv("MAGNEMITE_FAKE_CONVERGE_ERROR") != "" {
		result.Error = os.Getenv("MAGNEMITE_FAKE_CONVERGE_ERROR")
		result.Output = "fake docker: " + result.Error
		return result
	}

	// The containers the hub asked for become the containers this machine
	// reports, which is what makes the dashboard's running/desired count real
	// in fake mode rather than a constant.
	f.mu.Lock()
	f.containers = nil
	for _, name := range services {
		limit := uint64(4) * 1024 * 1024 * 1024
		restarts := 0
		f.containers = append(f.containers, proto.ContainerStat{
			Name:          req.Project + "-" + name,
			State:         "running",
			Serial:        serialFromCompose(req.Compose, name),
			RestartCount:  &restarts,
			MemLimitBytes: &limit,
			Image:         "magnemite/redroid:1",
		})
	}
	f.mu.Unlock()

	result.Ok = true
	result.Output = "fake docker: converged " + strconv.Itoa(len(services)) + " services"
	return result
}

// serialFromCompose finds the serial the rendered file gives one service, so a
// fake container matches its instance row the way a real one does.
func serialFromCompose(compose, service string) string {
	lines := strings.Split(compose, "\n")
	for i, line := range lines {
		if strings.TrimSpace(line) != service+":" {
			continue
		}
		for _, rest := range lines[i+1:] {
			trimmed := strings.TrimSpace(rest)
			// The next service at the same level ends this one's block.
			if trimmed != "" && !strings.HasPrefix(rest, "    ") {
				break
			}
			if serial := serialFromCmd([]string{strings.TrimPrefix(trimmed, "- ")}); serial != "" {
				return serial
			}
		}
		break
	}
	return ""
}
