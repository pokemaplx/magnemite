package sys

import (
	"context"
	"errors"
	"io"
	"os"
	"runtime"
	"strings"
	"time"

	"magnemite/agent/internal/proto"
)

// Host is the Linux machine that runs Redroid containers, as a System.
//
// It exists because a host *is* a Device: the same enrollment, the same socket,
// the same `welcome`, the same metrics table and the same self-update all apply
// to it, and satisfying the same interface is what gets all of that for free.
//
// It embeds Android rather than reimplementing it, which looks odd and is
// right: nearly every reading on that type is a /proc file that means the same
// thing on a VPS as in a container — the load average, the thermal zones, the
// disk, the atomic write, the shell. A second copy of them would be a second
// place for the units to drift, and this file would then be the one that was
// subtly wrong, because it is the one nobody runs on a laptop.
//
// What is overridden below is only the genuinely different: a machine has no
// Android properties, no `pm`, no logcat, and no binder services to wait for.
// Most of it is the honest refusal of those rather than a stub that lies.
type Host struct {
	*Android

	// Where to measure free space. Docker's data root when it exists, because
	// that is the filesystem images and volumes actually fill — a machine whose
	// / has room while /var/lib/docker is full fails every install, for a
	// reason nothing else would show.
	diskPath string
}

// Checked at compile time, the same way Fake is: the point of this type is to
// be a Device like any other, and a missing method would only surface as a
// machine that cannot enrol.
var _ System = (*Host)(nil)

var errNotAndroid = errors.New("this is a Linux host, not an Android box")

// NewHost takes the serial the bootstrap minted. Never derived from
// /etc/machine-id: imaging a VPS from a snapshot clones that file, and two
// machines claiming one row would fight over the socket forever.
func NewHost(serial string) *Host {
	disk := "/var/lib/docker"
	if _, err := os.Stat(disk); err != nil {
		disk = "/"
	}
	return &Host{Android: NewAndroid(serial), diskPath: disk}
}

// DiskPath is where this host measures free space, so the report can say so.
func (h *Host) DiskPath() string { return h.diskPath }

// --- what a machine has no equivalent of -----------------------------------

// Prop is empty rather than an error: properties are read in passing all over
// the agent, and a machine simply has none.
func (h *Host) Prop(ctx context.Context, name string) string { return "" }

// PackageInfo and ThirdPartyPackages fail rather than return nothing, so no
// caller can mistake "this machine installs no apps" for "no apps are
// installed". `Metrics` skips a failing PackageInfo, which is how the tracked
// package list comes to simply not apply here.
func (h *Host) PackageInfo(ctx context.Context, pkg string) (proto.PackageInfo, error) {
	return proto.PackageInfo{}, errNotAndroid
}

func (h *Host) ThirdPartyPackages(ctx context.Context) ([]proto.PackageInfo, error) {
	return nil, errNotAndroid
}

// ProcessStats is empty because its argument is a list of Android packages. The
// figure that does matter for a machine — how busy the whole thing is — is
// CPUPercent.
func (h *Host) ProcessStats(packages []string) []proto.ProcessStats { return nil }

// SystemServicesUp is always true. On a box this waits for the binder services
// an install needs; a machine installs nothing, and inheriting the real check
// would block forever on something that can never pass.
func (h *Host) SystemServicesUp(ctx context.Context) bool { return true }

func (h *Host) LogcatStream(ctx context.Context) (io.ReadCloser, error) {
	return nil, errNotAndroid
}

// --- the two readings that need a different source --------------------------

// Disk ignores the path it is given. The caller asks about /data, which a
// machine does not have; where the containers actually live is the useful
// answer, and the only one a HOST_DISK_LOW rule can act on.
func (h *Host) Disk(path string) (uint64, uint64, error) {
	return h.Android.Disk(h.diskPath)
}

// Memory is the machine's own, from meminfo. The inherited version prefers a
// cgroup limit, which is right for a container and wrong here: a limit on the
// machine's root cgroup is not what anyone means by how much RAM the machine
// has.
func (h *Host) Memory() (uint64, uint64) {
	return meminfoMemory(readProc("/proc/meminfo"))
}

// CPUPercent reads /proc/stat, with no cgroup branch. On a machine that file
// *is* the machine — which is the whole difference from a container, where the
// same file is the host's and says nothing about the box.
func (h *Host) CPUPercent() *float64 {
	ticks, ok := busyTicks(readProc("/proc/stat"))
	if !ok {
		return nil
	}
	cur := machineCPU{seconds: float64(ticks) / clockTicksPerSecond, at: time.Now()}

	h.cpuMu.Lock()
	prev := h.lastMachineCPU
	h.lastMachineCPU = cur
	h.cpuMu.Unlock()

	return cpuRate(prev, cur, 5*time.Minute)
}

// --- identity ---------------------------------------------------------------

func (h *Host) DeviceInfo(ctx context.Context) proto.DeviceInfo {
	return proto.DeviceInfo{
		Serial: h.serialOverride,
		// Reported so a machine gets agent updates at all: the hub maps the ABI
		// to one of its cross-compiled builds, and an empty one is simply never
		// offered an update. The Android spelling, because that mapping is
		// keyed on it.
		Abi:     hostAbi(),
		Model:   hostModel(),
		LocalIp: LocalIP(),
	}
}

// hostAbi translates the machine's architecture into the spelling the hub's
// build table is keyed on.
func hostAbi() string {
	switch runtime.GOARCH {
	case "arm64":
		return "arm64-v8a"
	case "arm":
		return "armeabi-v7a"
	default:
		// amd64 and anything else. There is no Redroid build for such a
		// machine and the bootstrap refuses one, but reporting the truth beats
		// reporting a lie that earns it the wrong binary.
		return runtime.GOARCH
	}
}

// hostModel is the kernel release, which is the fact about a machine worth
// putting where a box puts its model: `linux-modules-extra` is per kernel
// version, so a kernel that moved is the explanation for a machine whose
// containers all stopped coming up after a reboot.
func hostModel() string {
	release := strings.TrimSpace(readProc("/proc/sys/kernel/osrelease"))
	if release == "" {
		return "linux"
	}
	return "Linux " + release
}
