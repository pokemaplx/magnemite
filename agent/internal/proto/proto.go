// Package proto mirrors packages/protocol/src/index.ts. Change both together.
//
// Compatibility rule: agents update themselves over the air and a box that
// sat powered off for a month reconnects running an old build. Only ever add
// optional fields; never repurpose or remove one.
package proto

const Version = 1

// Job states, matching the JobState enum in the Prisma schema.
const (
	StateQueued      = "QUEUED"
	StateDispatched  = "DISPATCHED"
	StateDownloading = "DOWNLOADING"
	StateExtracting  = "EXTRACTING"
	StateInstalling  = "INSTALLING"
	StateVerifying   = "VERIFYING"
	StateSuccess     = "SUCCESS"
	StateFailed      = "FAILED"
	StateCancelled   = "CANCELLED"
)

const (
	InstallModeInPlace = "IN_PLACE"
	InstallModeClean   = "CLEAN"
)

const (
	LevelDebug = "DEBUG"
	LevelInfo  = "INFO"
	LevelWarn  = "WARN"
	LevelError = "ERROR"
)

type PackageInfo struct {
	PackageName string `json:"packageName"`
	VersionName string `json:"versionName,omitempty"`
	// String because an Android versionCode can exceed 2^31.
	VersionCode string `json:"versionCode,omitempty"`
	Installed   bool   `json:"installed"`
}

type DeviceInfo struct {
	Serial         string `json:"serial"`
	Manufacturer   string `json:"manufacturer,omitempty"`
	Model          string `json:"model,omitempty"`
	AndroidVersion string `json:"androidVersion,omitempty"`
	SdkInt         int    `json:"sdkInt,omitempty"`
	Abi            string `json:"abi,omitempty"`
	Density        int    `json:"density,omitempty"`
	// LAN address of the box itself. The hub only ever sees the reverse
	// proxy's address on its own network, so this is the only way it learns
	// where the box sits on the local network.
	LocalIp string `json:"localIp,omitempty"`
}

// ProcessStats is what one tracked app costs the box, summed over every
// process the package owns. See the matching doc comment on the TypeScript
// side for why CPUPercent is a share of one core rather than of the whole box.
type ProcessStats struct {
	PackageName string  `json:"packageName"`
	CPUPercent  float64 `json:"cpuPercent,omitempty"`
	RSSBytes    uint64  `json:"rssBytes,omitempty"`
	// Pointer so a running app with a genuine zero never looks like an app the
	// agent could not read. omitempty on a plain int would drop both.
	ProcessCount *int `json:"processCount,omitempty"`
}

type DeviceMetrics struct {
	FreeBytes     uint64        `json:"freeBytes"`
	TotalBytes    uint64        `json:"totalBytes"`
	UptimeSeconds int64         `json:"uptimeSeconds"`
	Packages      []PackageInfo `json:"packages"`
	// True when Packages is the box's whole third-party inventory rather than
	// just the apps the hub asked about. The hub needs to know the difference:
	// only a complete list is evidence that something was uninstalled.
	PackagesComplete bool `json:"packagesComplete,omitempty"`

	// Cheap health signals, read straight out of /proc on every heartbeat.
	// Omitted by agents older than this field, which is why the hub treats
	// every one of them as optional.
	LoadAvg1          float64 `json:"loadAvg1,omitempty"`
	LoadAvg5          float64 `json:"loadAvg5,omitempty"`
	LoadAvg15         float64 `json:"loadAvg15,omitempty"`
	CPUCount          int     `json:"cpuCount,omitempty"`
	MemTotalBytes     uint64  `json:"memTotalBytes,omitempty"`
	MemAvailableBytes uint64  `json:"memAvailableBytes,omitempty"`

	// Share of a single core across the whole machine, so 250 means two and a
	// half cores spent. The only CPU figure a container actually has: inside
	// one, /proc/loadavg is the host's, while its own cgroup accounts its CPU
	// time exactly.
	//
	// All three of these are pointers for the reason ProcessCount is one, and
	// here it matters more: an idle machine reads a genuine 0.0, and a machine
	// with no swap reads a genuine 0 bytes. omitempty on plain values would
	// drop both, and the hub writes an absent field as "leave what you had" --
	// so a stale number would sit on the row forever.
	CPUPercent     *float64 `json:"cpuPercent,omitempty"`
	SwapTotalBytes *uint64  `json:"swapTotalBytes,omitempty"`
	SwapFreeBytes  *uint64  `json:"swapFreeBytes,omitempty"`

	// Degrees Celsius. Plenty of TV boxes expose no thermal zone at all, so
	// omitempty here means "this box cannot say" — which the hub stores as
	// null and the dashboard renders as an absent chart, not a zero.
	CPUTempC     float64 `json:"cpuTempC,omitempty"`
	BatteryTempC float64 `json:"batteryTempC,omitempty"`

	// Per-app CPU and memory for the packages the hub asked to track.
	Processes []ProcessStats `json:"processes,omitempty"`

	// What the box saw running the monitor spec from its welcome. All of it is
	// omitted by an agent from before monitoring existed, and the hub reads
	// that absence as "unknown", never as "failing".
	//
	// MonitorRan is what makes the rest readable: an empty ForegroundPackage
	// means the launcher is up, which is a fault, and it also means "this
	// agent never looked", which is not. The flag separates them.
	MonitorRan        bool          `json:"monitorRan,omitempty"`
	ForegroundPackage string        `json:"foregroundPackage,omitempty"`
	ANRPackages       []string      `json:"anrPackages,omitempty"`
	Checks            []CheckResult `json:"checks,omitempty"`
}

// CheckResult is what one configured probe came back with. The agent applies
// the thresholds itself: the alternative is shipping a window of the scanner's
// log over the socket every twenty seconds.
type CheckResult struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
	Ms     int64  `json:"ms,omitempty"`
}

// --- agent -> hub ----------------------------------------------------------

// ContainerStat is one Redroid container as the host's docker saw it.
//
// This is the half of an instance's state nothing inside the container can
// see: docker stats reports neither the state nor the restart count, and a
// process in the guest cannot ask. Everything else about a box comes from the
// agent inside it, over its own socket.
type ContainerStat struct {
	Name string `json:"name"`
	// The serial the container was started with, read back off its own command
	// line rather than assumed -- which is what makes adopting a hand-written
	// compose file possible at all.
	Serial string `json:"serial,omitempty"`
	// docker's own word: running, exited, restarting, created, paused.
	State string `json:"state"`
	// Pointers, same rule as everywhere else here: a container that has never
	// restarted reports a genuine zero, and a limit of zero means unlimited.
	RestartCount  *int    `json:"restartCount,omitempty"`
	MemLimitBytes *uint64 `json:"memLimitBytes,omitempty"`
	Image         string  `json:"image,omitempty"`
}

// HostInfo is what a machine says about itself, beyond the readings every
// Device sends. Omitted entirely by a box, which is what lets the host half
// ride the socket that already exists rather than needing one of its own.
type HostInfo struct {
	// uname -m. arm64 is a hard requirement, and this is the evidence of what
	// the bootstrap found rather than an assumption.
	Arch string `json:"arch,omitempty"`
	// uname -r. Its own field because linux-modules-extra is per kernel
	// version: an apt upgrade that installs a new kernel leaves binder behind
	// and every container fails to come up after the reboot.
	Kernel        string `json:"kernel,omitempty"`
	DockerVersion string `json:"dockerVersion,omitempty"`
	// Whether the binder devices Android needs were actually present, as
	// opposed to the modprobe having been run. A pointer because false is the
	// answer that matters and omitempty would hide it.
	BinderOk *bool  `json:"binderOk,omitempty"`
	Project  string `json:"project,omitempty"`
	// sha256 of the compose file on disk, read back after writing it -- what is
	// on the machine rather than what the hub meant, the same rule a written
	// MITM config follows.
	ComposeSha256 string `json:"composeSha256,omitempty"`
	// Every container under the project, running or not. Empty is a real
	// answer: a machine with nothing on it yet.
	Containers []ContainerStat `json:"containers"`
}

// HostConverge brings the containers on a machine in line with the hub's
// desired set. Carries the whole set every time, never a delta, which is what
// makes it idempotent and drift self-correcting.
type HostConverge struct {
	Type      string `json:"type"` // "host_converge"
	RequestID string `json:"requestId"`
	Project   string `json:"project"`
	Dir       string `json:"dir"`
	// The rendered compose file. The hub renders it, not the machine, so the
	// bytes are the auditable artifact and the hub can compare a fresh render
	// against the sha256 the machine read back to decide whether a converge is
	// needed at all.
	Compose string `json:"compose"`
	// How many containers may start at once. `docker compose up` starts every
	// service simultaneously, and ten Androids coming up together is the OOM
	// the sizing advice warns about.
	BatchSize int `json:"batchSize"`
	// Whether containers the file does not name may be removed. False until a
	// machine has converged once: one running the hand-written compose file has
	// containers holding real device identities, and an empty desired set would
	// make every one of them an orphan.
	RemoveOrphans bool `json:"removeOrphans"`
}

// HostBootstrap asks a machine to run the bootstrap again.
//
// The script is already on the machine -- it installs itself there for exactly
// this -- but it is sent again, and so are the files that build the Redroid
// image. A re-run whose point is to deliver a *fixed* image cannot use the
// copies from the day the machine was provisioned: those are the ones being
// replaced.
type HostBootstrap struct {
	Type      string `json:"type"` // "host_bootstrap"
	RequestID string `json:"requestId"`
	Script    string `json:"script"`
	// Written into a redroid/ directory beside the script. The script looks
	// for it relative to its working directory, so where these land decides
	// whether the image is rebuilt at all.
	Files []BootstrapFile `json:"files,omitempty"`
	Image string          `json:"image"`
	// The whole run: apt, a kernel module, possibly an image build.
	TimeoutSeconds int `json:"timeoutSeconds"`
}

type BootstrapFile struct {
	Name    string `json:"name"`
	Content string `json:"content"`
	// Octal as a string, the way a config file's mode travels.
	Mode string `json:"mode,omitempty"`
}

// BootstrapStep is one `::step` line the script printed. Parsed on the machine
// rather than at the hub, because over this path there is no SSH stream for
// the hub to read -- but it is the same script and the same markers.
type BootstrapStep struct {
	Name   string `json:"name"`
	Ok     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
}

type HostBootstrapResult struct {
	Type      string `json:"type"` // "host_bootstrap_result"
	RequestID string `json:"requestId"`
	Ok        bool   `json:"ok"`
	// Never nil: a run that printed no step at all still sends [], because a
	// nil slice is JSON null and the hub's schema takes an array.
	Steps []BootstrapStep `json:"steps"`
	Error string          `json:"error,omitempty"`
}

// HostConvergeResult is what the machine did about it.
type HostConvergeResult struct {
	Type      string `json:"type"` // "host_converge_result"
	RequestID string `json:"requestId"`
	Ok        bool   `json:"ok"`
	// sha256 of the file as read back off disk, not of what was sent: it says
	// what is on the machine rather than what the hub meant.
	ComposeSha256 string `json:"composeSha256,omitempty"`
	// Docker's own output, capped here rather than at the hub. A frame is 1 MB
	// and the column it lands in is 64 KB on MariaDB, so an uncapped cold image
	// build would close the socket or fail the insert -- and either way the hub
	// would never record the hash, see the same mismatch on the next reconnect,
	// and converge forever.
	Output string `json:"output,omitempty"`
	Error  string `json:"error,omitempty"`
}

type Hello struct {
	Type            string        `json:"type"` // "hello"
	ProtocolVersion int           `json:"protocolVersion"`
	AgentVersion    string        `json:"agentVersion"`
	Device          DeviceInfo    `json:"device"`
	Metrics         DeviceMetrics `json:"metrics"`
	CurrentJobID    string        `json:"currentJobId,omitempty"`
	// What this build can be asked to do, beyond the message set that has
	// always existed. The hub gates on this rather than comparing AgentVersion:
	// version arithmetic reads a backported build as too old, and what that
	// costs is a message sent to a box that silently drops it.
	Capabilities []string `json:"capabilities,omitempty"`
	// Set only in host mode. Absent from every box.
	Host *HostInfo `json:"host,omitempty"`
}

// Capabilities this build reports in Hello. Add the constant next to the
// handler that implements it, not before.
const (
	CapabilityWriteConfig = "write_config"
)

// AgentCapabilities is what this binary claims it can do.
func AgentCapabilities() []string {
	return []string{CapabilityWriteConfig}
}

type Heartbeat struct {
	Type         string        `json:"type"` // "heartbeat"
	Metrics      DeviceMetrics `json:"metrics"`
	CurrentJobID string        `json:"currentJobId,omitempty"`
	// Set only in host mode. Absent from every box.
	Host *HostInfo `json:"host,omitempty"`
}

type JobProgress struct {
	Type     string `json:"type"` // "job_progress"
	JobID    string `json:"jobId"`
	State    string `json:"state"`
	Progress int    `json:"progress"`
	Message  string `json:"message,omitempty"`
}

type JobResult struct {
	Type                 string `json:"type"` // "job_result"
	JobID                string `json:"jobId"`
	OK                   bool   `json:"ok"`
	InstallMode          string `json:"installMode,omitempty"`
	DataWiped            bool   `json:"dataWiped"`
	InstalledVersion     string `json:"installedVersion,omitempty"`
	InstalledVersionCode string `json:"installedVersionCode,omitempty"`
	Error                string `json:"error,omitempty"`
}

type LogMessage struct {
	Type    string `json:"type"` // "log"
	JobID   string `json:"jobId,omitempty"`
	Level   string `json:"level"`
	Message string `json:"message"`
}

// AgentUpdateResult reports a self-update that did not happen. Success is not
// reported: the agent re-execs, and the hello the new binary sends is the only
// proof that it actually runs.
type AgentUpdateResult struct {
	Type    string `json:"type"` // "agent_update_result"
	Version string `json:"version"`
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
}

// LogBundleResult closes out a bundle the agent could not deliver. A bundle
// that worked needs no frame: the hub learns of it from the upload itself.
type LogBundleResult struct {
	Type     string `json:"type"` // "log_bundle_result"
	BundleID string `json:"bundleId"`
	OK       bool   `json:"ok"`
	Error    string `json:"error,omitempty"`
}

// LogLines is a batch of live logcat lines. Dropped counts what was thrown
// away to keep up with a noisy box, so the dashboard can say so.
type LogLines struct {
	Type     string   `json:"type"` // "log_lines"
	StreamID string   `json:"streamId"`
	Lines    []string `json:"lines"`
	Dropped  int      `json:"dropped"`
}

// ExecResult is what a one-off command printed. Output is combined stdout and
// stderr, truncated by the agent before it ever reaches the socket.
type ExecResult struct {
	Type      string `json:"type"` // "exec_result"
	CommandID string `json:"commandId"`
	OK        bool   `json:"ok"`
	Output    string `json:"output"`
	Error     string `json:"error,omitempty"`
}

// --- hub -> agent ----------------------------------------------------------

// Envelope is decoded first to find out which concrete message arrived.
type Envelope struct {
	Type string `json:"type"`
}

type Welcome struct {
	Type             string   `json:"type"`
	DeviceID         string   `json:"deviceId"`
	Name             string   `json:"name"`
	Approved         bool     `json:"approved"`
	HeartbeatSeconds int      `json:"heartbeatSeconds"`
	TrackedPackages  []string `json:"trackedPackages"`
	// What to watch for, or nil for a fleet with monitoring off. Adopted the
	// same way TrackedPackages is, so a changed spec takes effect on the next
	// welcome rather than on a reconnect.
	Monitor *MonitorSpec `json:"monitor,omitempty"`
}

// MonitorSpec is everything the box should look at on each beat.
type MonitorSpec struct {
	Foreground bool               `json:"foreground,omitempty"`
	ANR        bool               `json:"anr,omitempty"`
	Checks     []MonitorCheckSpec `json:"checks,omitempty"`
}

// MonitorCheckSpec is one probe. None of these strings are hard-coded on
// either side: every MITM writes a different log and answers to a different
// service name, so they are rows in the database an operator edits per fleet.
type MonitorCheckSpec struct {
	ID   string `json:"id"`
	Kind string `json:"kind"` // "shell" | "http" | "logMatch"
	// shell: the command · http: the URL · logMatch: the log file's path.
	Target string `json:"target"`
	// shell: a regex the output must match · logMatch: a regex counted as a fault.
	Expect string `json:"expect,omitempty"`
	// logMatch: how many trailing lines to read.
	Lines int `json:"lines,omitempty"`
	// logMatch: matches inside that window before the check fails.
	FailAt int `json:"failAt,omitempty"`
	// logMatch: a regex counted as a success, so the check can be a ratio
	// rather than a count — some faults are normal under load and only mean
	// something when they outnumber the work getting done.
	SuccessPattern string `json:"successPattern,omitempty"`
	// logMatch: fail when faults >= successes * this. Zero skips the ratio.
	MaxRatio float64 `json:"maxRatio,omitempty"`
	// logMatch: also fail when the file itself has not been written to for
	// this long. The file's mtime, not a timestamp parsed out of a line: every
	// MITM formats its log differently, and "nothing written for five minutes"
	// is both format-independent and exactly what a stalled loop looks like.
	MaxAgeSeconds  int `json:"maxAgeSeconds,omitempty"`
	TimeoutSeconds int `json:"timeoutSeconds,omitempty"`
}

// ConfigFile is a file to put on the box, written between the verify and the
// post-install hook so the hook that starts the scanner never starts it against
// the previous site's settings.
//
// It rides InstallJob and nothing else. A WriteConfig message used to push one
// on its own, with a restart command to make the running process re-read it;
// both are gone, and a config now reaches a box by installing the MITM that
// reads it.
type ConfigFile struct {
	// Absolute path. The agent refuses system paths and its own config.
	Path    string `json:"path"`
	Content string `json:"content"`
	// Octal, as a string. Empty means 0644.
	Mode string `json:"mode,omitempty"`
}

type InstallJob struct {
	Type            string   `json:"type"`
	JobID           string   `json:"jobId"`
	PackageName     string   `json:"packageName"`
	URL             string   `json:"url"`
	SHA256          string   `json:"sha256"`
	SizeBytes       int64    `json:"sizeBytes"`
	Version         string   `json:"version"`
	ForceClean      bool     `json:"forceClean"`
	PreInstallHook  string   `json:"preInstallHook,omitempty"`
	PostInstallHook string   `json:"postInstallHook,omitempty"`
	ExtraSplits     []string `json:"extraSplits,omitempty"`
	// Written once the install verifies and before the post-install hook, so
	// the hook that starts the scanner never starts it against the previous
	// fleet's config. Nil for every app that is not this box's group MITM.
	Config         *ConfigFile `json:"config,omitempty"`
	TimeoutSeconds int         `json:"timeoutSeconds"`
}

type CancelJob struct {
	Type  string `json:"type"`
	JobID string `json:"jobId"`
}

type AgentUpdate struct {
	Type    string `json:"type"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
	Version string `json:"version"`
}

// CollectLogs asks for a zip of the box's logs, uploaded to UploadURL with the
// device token. MaxLines caps the logcat tail: the whole buffer is tens of MB.
type CollectLogs struct {
	Type      string `json:"type"`
	BundleID  string `json:"bundleId"`
	UploadURL string `json:"uploadUrl"`
	MaxLines  int    `json:"maxLines"`
}

// LogStreamStart runs logcat live. DurationSeconds is a hard stop the agent
// enforces itself, so a browser that vanished never leaves logcat running.
type LogStreamStart struct {
	Type     string `json:"type"`
	StreamID string `json:"streamId"`
	// Absolute path of a file to follow. Empty means logcat.
	Path            string `json:"path,omitempty"`
	DurationSeconds int    `json:"durationSeconds"`
}

type LogStreamStop struct {
	Type     string `json:"type"`
	StreamID string `json:"streamId"`
}

// ExecCommand runs a shell command as root — the same thing the install hooks
// do, invoked by hand from the dashboard.
type ExecCommand struct {
	Type           string `json:"type"`
	CommandID      string `json:"commandId"`
	Command        string `json:"command"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
}

// --- enrollment ------------------------------------------------------------

type EnrollRequest struct {
	EnrollmentToken string     `json:"enrollmentToken"`
	Name            string     `json:"name,omitempty"`
	AgentVersion    string     `json:"agentVersion"`
	Device          DeviceInfo `json:"device"`
}

type EnrollResponse struct {
	DeviceID    string `json:"deviceId"`
	DeviceToken string `json:"deviceToken"`
	Name        string `json:"name"`
	Approved    bool   `json:"approved"`
	WsURL       string `json:"wsUrl"`
}
