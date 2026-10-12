import { z } from "zod";

/**
 * Wire protocol between the Go agent on each Android TV and the hub.
 *
 * Every frame is JSON with a `type` discriminator. The Go side mirrors these
 * shapes in agent/internal/proto/proto.go — change both together.
 *
 * Compatibility rule: agents update themselves over the air and a box that is
 * powered off for a month will reconnect running an old build. Only ever add
 * optional fields; never repurpose or remove one.
 */
export const PROTOCOL_VERSION = 1;

/**
 * A list that survives arriving as `null`.
 *
 * Go marshals a **nil slice as `null`**, not as `[]`, and `.default([])` only
 * fires on `undefined` — so one nil slice makes the whole frame fail
 * validation, and the hub drops frames whole. That is not a cosmetic loss: a
 * heartbeat carries the box's liveness as well as its readings, so a machine
 * whose agent could not list packages went offline on the dashboard while
 * sitting there perfectly healthy, with the reason only in the hub's log.
 *
 * It happened exactly once and the cost was a day, so every list on a frame an
 * agent sends goes through this rather than through `.default([])`. Absent,
 * null and empty all mean the same thing here — nothing to report — and none
 * of them is worth losing the readings around it.
 */
function listOf<T extends z.ZodTypeAny>(schema: T) {
  return z
    .array(schema)
    .nullish()
    .transform((value) => value ?? []);
}

/** Mirrors the JobState enum in the Prisma schema. */
export const jobStateSchema = z.enum([
  "QUEUED",
  "DISPATCHED",
  "DOWNLOADING",
  "EXTRACTING",
  "INSTALLING",
  "VERIFYING",
  "SUCCESS",
  "FAILED",
  "CANCELLED",
  "SKIPPED",
]);
export type JobStateWire = z.infer<typeof jobStateSchema>;

export const installModeSchema = z.enum(["IN_PLACE", "CLEAN"]);
export const logLevelSchema = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]);

export const packageInfoSchema = z.object({
  packageName: z.string(),
  versionName: z.string().nullish(),
  /** Android versionCode. Sent as a string: it can exceed 2^31. */
  versionCode: z.string().nullish(),
  installed: z.boolean().default(true),
});
export type PackageInfo = z.infer<typeof packageInfoSchema>;

export const deviceInfoSchema = z.object({
  serial: z.string().min(1),
  manufacturer: z.string().nullish(),
  model: z.string().nullish(),
  androidVersion: z.string().nullish(),
  sdkInt: z.number().int().nullish(),
  abi: z.string().nullish(),
  /** ro.sf.lcd_density, used to pick the right density split out of the .apkm. */
  density: z.number().int().nullish(),
  /**
   * The box's own LAN address (192.168.x.x and friends). The socket's remote
   * address is the reverse proxy on the hub's overlay network, so it is the
   * same useless 10.x for every device; only the agent knows where the box
   * actually lives on the local network. Null on agents old enough not to
   * report it.
   */
  localIp: z.string().nullish(),
});

/**
 * What one tracked app is costing the box right now.
 *
 * Summed across every process the package owns — an app with a `:remote`
 * service is two entries in /proc and one line here — because what an operator
 * asks is "what is the scanner costing me", not "what is each of its processes
 * costing me".
 */
export const processStatsSchema = z.object({
  packageName: z.string(),
  /**
   * Share of a *single* core, so 200 means two cores pinned. Deliberately not
   * normalised against the core count: this is the number `top` shows, and a
   * value above 100 is the honest way to say an app is using more than one
   * core. The dashboard divides by cpuCount when it wants a box-wide share.
   */
  cpuPercent: z.number().nonnegative().nullish(),
  /** Resident set size, summed across the app's processes. */
  rssBytes: z.number().nonnegative().nullish(),
  /** How many processes the package had running when this was read. */
  processCount: z.number().int().nonnegative().nullish(),
});
export type ProcessStats = z.infer<typeof processStatsSchema>;

/**
 * What one configured probe came back with.
 *
 * `ok` is the whole answer — the agent applies the thresholds, because the
 * alternative is shipping a log window over the socket every twenty seconds.
 * `detail` is the one line an operator needs to understand a failure, capped
 * hard: this rides every heartbeat and a frame is 1 MB.
 */
export const monitorCheckResultSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  detail: z.string().nullish(),
  /** How long the probe took, for spotting one that is too expensive to run. */
  ms: z.number().int().nonnegative().nullish(),
});
export type MonitorCheckResult = z.infer<typeof monitorCheckResultSchema>;

export const deviceMetricsSchema = z.object({
  /** Free bytes on /data — the partition the install session writes to. */
  freeBytes: z.number().nonnegative().nullish(),
  totalBytes: z.number().nonnegative().nullish(),
  uptimeSeconds: z.number().int().nonnegative().nullish(),
  packages: listOf(packageInfoSchema),
  /**
   * Set when `packages` is the whole third-party inventory rather than just
   * the tracked apps. Only a complete list is evidence that an app was
   * uninstalled, so the hub will not mark anything gone without it.
   */
  packagesComplete: z.boolean().default(false),

  /**
   * Health signals read out of /proc on every heartbeat. All optional: a box
   * running an agent from before these existed simply never sends them, and
   * the dashboard shows the fields as unknown rather than as zero.
   */
  loadAvg1: z.number().nonnegative().nullish(),
  loadAvg5: z.number().nonnegative().nullish(),
  loadAvg15: z.number().nonnegative().nullish(),
  cpuCount: z.number().int().positive().nullish(),
  memTotalBytes: z.number().nonnegative().nullish(),
  memAvailableBytes: z.number().nonnegative().nullish(),

  /**
   * Share of a *single* core this whole machine is spending, so 250 means two
   * and a half cores — the same convention as `processStatsSchema`, and the
   * one that composes.
   *
   * The honest version of the load average, and the only CPU figure a
   * container has. Inside one, `/proc/loadavg` is the host's and there is
   * nothing to scope it to; its own cgroup accounts its CPU time exactly. On
   * hardware this is `/proc/stat` deltas and means the same thing, which is
   * what lets a TV box and a container share one chart.
   */
  cpuPercent: z.number().nonnegative().nullish(),

  /**
   * Swap, which in practice only a host has. Fifty workers in a container is
   * where a VPS runs out of RAM, and swap is what stands between that and the
   * OOM killer taking a box down mid-scan.
   *
   * Zero is a real answer and means *no swap configured*, which is worth
   * knowing. That is why the Go side sends these as pointers: `omitempty` on a
   * plain integer would drop a genuine zero and the hub would read it as "has
   * not said yet".
   */
  swapTotalBytes: z.number().nonnegative().nullish(),
  swapFreeBytes: z.number().nonnegative().nullish(),

  /**
   * Degrees Celsius off the box's thermal zones. Not every ROM exposes one —
   * plenty of TV boxes ship with an empty /sys/class/thermal — so null here
   * means "this box cannot say", which the dashboard shows as an absent chart
   * rather than as a flat line at zero.
   */
  cpuTempC: z.number().nullish(),
  batteryTempC: z.number().nullish(),

  /**
   * Per-app CPU and memory for the tracked packages, sampled the same beat as
   * everything above. Empty on agents old enough not to gather it, and empty
   * for an app that simply is not running.
   */
  processes: listOf(processStatsSchema),

  /**
   * What the box saw when it ran the monitor spec from its `welcome`.
   *
   * All three are absent on an agent from before monitoring existed, and the
   * hub has to read that absence as *unknown* rather than as *failing* — a
   * fleet updates its agents on its own schedule, and a rule that rebooted
   * every box still running last month's build would be a disaster.
   */
  /**
   * Set when the box actually ran a spec this beat. It is the difference
   * between "the launcher is up" and "this agent has never heard of
   * monitoring", which the three fields below cannot tell apart on their own —
   * both look like an absent `foregroundPackage`. One is a fault worth acting
   * on and the other is a box that must be left alone, so the flag is what
   * makes the rest of this readable at all.
   */
  monitorRan: z.boolean().default(false),
  foregroundPackage: z.string().nullish(),
  anrPackages: listOf(z.string()),
  checks: listOf(monitorCheckResultSchema),
});

// ---------------------------------------------------------------------------
// agent -> hub
// ---------------------------------------------------------------------------

/**
 * One Redroid container, as the host's docker saw it a moment ago.
 *
 * This is the half of an instance's state that nothing inside the container
 * can see: `docker stats` reports no container state and no restart count, and
 * a process in the guest has no way to ask. Everything else about a box — its
 * memory, its storage, its packages — comes from the agent inside it, over its
 * own socket, like any other box.
 */
export const containerStatSchema = z.object({
  /** The container's name, which the renderer derives from the instance index. */
  name: z.string(),
  /**
   * The serial the container was started with, read back off its own command
   * line rather than assumed. This is what matches it to an instance row, and
   * reading it back is what makes adoption of a hand-written compose file
   * possible at all.
   */
  serial: z.string().nullish(),
  /** docker's own word: running, exited, restarting, created, paused. */
  state: z.string(),
  /**
   * Climbing restart counts are what distinguish a crash-looping instance from
   * an idle one. Null from a docker that did not say, never zero for it.
   */
  restartCount: z.number().int().nonnegative().nullish(),
  /**
   * The memory limit docker reports it actually applied.
   *
   * Reported rather than assumed because it is the single most consequential
   * field in the rendered file: it is what makes a box report its own RAM
   * instead of the machine's, and a silent miss would have every container on
   * a host claiming the whole machine's memory. The hub compares it against
   * what it asked for.
   */
  memLimitBytes: z.number().nonnegative().nullish(),
  image: z.string().nullish(),
});
export type ContainerStat = z.infer<typeof containerStatSchema>;

/**
 * What a host says about itself, beyond the readings every machine sends.
 *
 * Optional on both `hello` and `heartbeat`, and absent from every box, which
 * is what lets this ride the existing socket rather than needing one of its
 * own. A host *is* a Device: same enrollment, same token, same `welcome`, same
 * metrics, same self-update.
 */
export const hostInfoSchema = z.object({
  /** `uname -m`. arm64 is a hard requirement, and this is the evidence. */
  arch: z.string().nullish(),
  /**
   * `uname -r`. Worth a column of its own because `linux-modules-extra` is per
   * kernel version: an apt upgrade that installs a new kernel leaves binder
   * behind and every container fails to come up after the reboot. Seeing the
   * kernel move is how that gets spotted.
   */
  kernel: z.string().nullish(),
  dockerVersion: z.string().nullish(),
  /**
   * Whether the binder devices Android needs were actually there, as opposed
   * to the modprobe having been run. Redroid's own documentation disagrees
   * with itself about whether a modern kernel needs the module at all, so the
   * end state is what gets checked.
   */
  binderOk: z.boolean().nullish(),
  /** The compose project the containers below were found under. */
  project: z.string().nullish(),
  /**
   * sha256 of the compose file on disk, read back after writing it.
   *
   * Says what is on the machine rather than what the hub meant — the same rule
   * a written MITM config follows. The hub compares a fresh render against
   * this to decide whether a converge is needed at all, which is why the
   * render has to be a pure function of the instance rows.
   */
  composeSha256: z.string().nullish(),
  /**
   * Every container under the project, running or not.
   *
   * Empty and absent mean the same thing here, and deliberately so: Go sends a
   * nil slice as `null`, and treating that as a third state cost a machine its
   * whole heartbeat once already. What separates "a machine with nothing on
   * it" from "docker could not be asked" is `dockerVersion` being empty, which
   * is the one signal the agent sets before it gives up — and it is what the
   * hub gates on before it writes anything about containers.
   */
  containers: listOf(containerStatSchema),
});
export type HostInfo = z.infer<typeof hostInfoSchema>;

export const helloSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int().default(1),
  agentVersion: z.string(),
  device: deviceInfoSchema,
  metrics: deviceMetricsSchema,
  /** Set when the agent is resuming a job it was running before it restarted. */
  currentJobId: z.string().nullish(),
  /**
   * What this build of the agent can be asked to do, beyond the message set
   * that has always existed. Empty from an agent old enough not to send it.
   *
   * The hub gates on this rather than comparing `agentVersion`: version
   * arithmetic reads a backported build as too old, and the failure mode is a
   * message sent to a box that silently drops it.
   */
  capabilities: listOf(z.string()),
  /** Set only by an agent in host mode. Absent from every box. */
  host: hostInfoSchema.nullish(),
});

export const heartbeatSchema = z.object({
  type: z.literal("heartbeat"),
  metrics: deviceMetricsSchema,
  currentJobId: z.string().nullish(),
  /** Set only by an agent in host mode. Absent from every box. */
  host: hostInfoSchema.nullish(),
});

export const jobProgressSchema = z.object({
  type: z.literal("job_progress"),
  jobId: z.string(),
  state: jobStateSchema,
  /** 0-100 within the current state. */
  progress: z.number().int().min(0).max(100).default(0),
  message: z.string().nullish(),
});

export const jobResultSchema = z.object({
  type: z.literal("job_result"),
  jobId: z.string(),
  ok: z.boolean(),
  installMode: installModeSchema.nullish(),
  /** True when the install had to uninstall first, wiping app data. */
  dataWiped: z.boolean().default(false),
  installedVersion: z.string().nullish(),
  installedVersionCode: z.string().nullish(),
  error: z.string().nullish(),
});

export const logSchema = z.object({
  type: z.literal("log"),
  jobId: z.string().nullish(),
  level: logLevelSchema.default("INFO"),
  message: z.string(),
});

/**
 * Sent when a self-update does not happen, so a failure is visible in the
 * dashboard rather than only in the box's own log. Success needs no frame:
 * the agent re-execs and the next `hello` carries the new version, which is
 * the only proof that the new binary actually runs.
 */
export const agentUpdateResultSchema = z.object({
  type: z.literal("agent_update_result"),
  /** Version the agent was told to move to. */
  version: z.string(),
  ok: z.boolean(),
  error: z.string().nullish(),
});

/**
 * Closes out a log bundle the agent could not deliver. The bundle itself goes
 * up over HTTP, not through here — a socket frame is capped at 1 MB and a
 * logcat dump is not.
 */
export const logBundleResultSchema = z.object({
  type: z.literal("log_bundle_result"),
  bundleId: z.string(),
  ok: z.boolean(),
  error: z.string().nullish(),
});

/**
 * A batch of live logcat lines, while someone has the panel open.
 *
 * Batched rather than sent per line: a busy box writes thousands a second and
 * one frame each would be the socket's whole budget. `dropped` counts what the
 * agent threw away to keep up, so the panel can say so instead of quietly
 * lying about what the box printed.
 */
export const logLinesSchema = z.object({
  type: z.literal("log_lines"),
  streamId: z.string(),
  lines: listOf(z.string()),
  dropped: z.number().int().nonnegative().default(0),
});

/** What a one-off command printed, and whether it worked. */
export const execResultSchema = z.object({
  type: z.literal("exec_result"),
  commandId: z.string(),
  ok: z.boolean(),
  /** Combined stdout and stderr, truncated by the agent. */
  output: z.string().default(""),
  /** Set when the shell itself reported a failure. */
  error: z.string().nullish(),
});

export const pongSchema = z.object({ type: z.literal("pong") });

/**
 * What the machine did about it.
 *
 * `output` is docker's own, capped by the agent: a frame is 1 MB and the
 * column it lands in is 64 KB on MariaDB, so an uncapped cold image build
 * would close the socket or fail the insert — and either way the hub would
 * never record the sha256, see the same mismatch on reconnect, and converge
 * forever.
 */
export const hostConvergeResultSchema = z.object({
  type: z.literal("host_converge_result"),
  requestId: z.string(),
  ok: z.boolean(),
  /** sha256 of the file as read back off disk, not of what was sent. */
  composeSha256: z.string().nullish(),
  output: z.string().nullish(),
  error: z.string().nullish(),
});
export type HostConvergeResult = z.infer<typeof hostConvergeResultSchema>;

export const agentMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  heartbeatSchema,
  jobProgressSchema,
  jobResultSchema,
  logSchema,
  agentUpdateResultSchema,
  logBundleResultSchema,
  logLinesSchema,
  execResultSchema,
  pongSchema,
  hostConvergeResultSchema,
]);
export type AgentMessage = z.infer<typeof agentMessageSchema>;

// ---------------------------------------------------------------------------
// hub -> agent
// ---------------------------------------------------------------------------

/**
 * One thing the box should look at on every beat.
 *
 * The thresholds live here rather than on the hub because the evidence lives
 * on the box: `logMatch` is a window of the scanner's own log file, and the
 * whole point is to answer "is this thing working" without shipping the log.
 *
 * Every MITM writes a different log and answers to a different service name,
 * which is why none of these strings are hard-coded — they are rows in the
 * database that an operator edits per fleet, or per group.
 */
export const monitorCheckSpecSchema = z.object({
  /** Matches the `id` in the result, and the rule that asked for it. */
  id: z.string(),
  kind: z.enum(["shell", "http", "logMatch"]),
  /** shell: the command · http: the URL · logMatch: the log file's path. */
  target: z.string(),
  /** shell: a regex the output must match · logMatch: a regex counted as a fault. */
  expect: z.string().nullish(),
  /** logMatch: how many trailing lines to read. */
  lines: z.number().int().positive().default(200),
  /** logMatch: matches inside that window before the check fails. */
  failAt: z.number().int().positive().default(1),
  /**
   * logMatch: a regex counted as a success, so the check can be a ratio
   * rather than a count. Some faults are normal under load and only mean
   * something when they outnumber the work getting done.
   */
  successPattern: z.string().nullish(),
  /** logMatch: fail when faults ≥ successes × this. Null skips the ratio. */
  maxRatio: z.number().positive().nullish(),
  /**
   * logMatch: also fail when the file itself has not been written to for this
   * long. Deliberately the file's mtime rather than a timestamp parsed out of
   * a line — every MITM formats its log differently, and "nothing has been
   * written here for five minutes" is both format-independent and exactly
   * what a stalled loop looks like.
   */
  maxAgeSeconds: z.number().int().positive().nullish(),
  timeoutSeconds: z.number().int().positive().default(10),
});
export type MonitorCheckSpec = z.infer<typeof monitorCheckSpecSchema>;

/** Everything the box should watch, sent with the `welcome` that accepts it. */
export const monitorSpecSchema = z.object({
  /** Report which package owns the focused activity. */
  foreground: z.boolean().default(false),
  /** Report packages sitting on an ANR dialog. */
  anr: z.boolean().default(false),
  checks: z.array(monitorCheckSpecSchema).default([]),
});
export type MonitorSpec = z.infer<typeof monitorSpecSchema>;

export const welcomeSchema = z.object({
  type: z.literal("welcome"),
  deviceId: z.string(),
  name: z.string(),
  approved: z.boolean(),
  heartbeatSeconds: z.number().int().positive().default(20),
  /** Packages the agent should report versions for on every heartbeat. */
  trackedPackages: z.array(z.string()).default([]),
  /**
   * What to watch for, or null for a fleet with monitoring switched off. Like
   * the heartbeat interval, a box only learns a changed spec on its next
   * `welcome` — which the hub pushes on save rather than leaving to a
   * reconnect.
   */
  monitor: monitorSpecSchema.nullish(),
});

/**
 * A file to put on the box, written between the verify and the post-install
 * hook so the hook that starts the scanner never starts it against the
 * previous site's settings.
 *
 * It rides `install_job` and nothing else. There was a `write_config` message
 * that pushed one on its own, with a restart command to make the running
 * process re-read it; both are gone. A config reaches a box by installing the
 * MITM that reads it, and the post-install hook is what starts that MITM.
 */
export const deviceConfigFileSchema = z.object({
  /** Absolute path. The agent refuses system paths and its own config. */
  path: z.string().min(1),
  content: z.string(),
  /** Octal, as a string. 0644 is right for /data/local/tmp. */
  mode: z.string().default("0644"),
});
export type DeviceConfigFile = z.infer<typeof deviceConfigFileSchema>;

export const installJobSchema = z.object({
  type: z.literal("install_job"),
  jobId: z.string(),
  packageName: z.string(),
  /** Absolute URL of the cached .apkm, served by Caddy under /files/. */
  url: z.string().url(),
  sha256: z.string().length(64),
  sizeBytes: z.number().positive(),
  version: z.string(),
  /** Uninstall before installing instead of only on an in-place rejection. */
  forceClean: z.boolean().default(false),
  preInstallHook: z.string().nullish(),
  postInstallHook: z.string().nullish(),
  /**
   * Extra split APKs to install beyond base + the device's own abi/density
   * splits, matched by name. Rarely needed.
   */
  extraSplits: z.array(z.string()).default([]),
  /**
   * Written once the install verifies and before the post-install hook, so the
   * hook that starts the scanner never starts it against the previous fleet's
   * config. Absent for every app that is not the box's group MITM, and ignored
   * outright by an agent old enough not to know the field.
   */
  config: deviceConfigFileSchema.nullish(),
  /** Seconds before the agent gives up on the whole job. */
  timeoutSeconds: z.number().int().positive().default(3600),
});
export type InstallJob = z.infer<typeof installJobSchema>;

export const cancelJobSchema = z.object({
  type: z.literal("cancel_job"),
  jobId: z.string(),
});

export const rebootSchema = z.object({ type: z.literal("reboot") });

export const agentUpdateSchema = z.object({
  type: z.literal("agent_update"),
  url: z.string().url(),
  sha256: z.string().length(64),
  version: z.string(),
});

/**
 * Collect the box's logs and PUT them at `uploadUrl`, which carries the
 * bundle's own id and is authenticated with the device token.
 */
export const collectLogsSchema = z.object({
  type: z.literal("collect_logs"),
  bundleId: z.string(),
  uploadUrl: z.string().url(),
  /** Tail of logcat to include. A full buffer is tens of MB. */
  maxLines: z.number().int().positive().default(50_000),
});

export const logStreamStartSchema = z.object({
  type: z.literal("log_stream_start"),
  streamId: z.string(),
  /**
   * Absolute path of a log file to follow. Null means logcat, which is what
   * an agent from before this field understood — and still does, because it
   * simply ignores what it does not know.
   */
  path: z.string().nullish(),
  /**
   * The agent stops on its own after this, so a dashboard tab left open (or a
   * browser that died without closing the stream) never leaves `logcat`
   * running on the box forever.
   */
  durationSeconds: z.number().int().positive().default(300),
});

export const logStreamStopSchema = z.object({
  type: z.literal("log_stream_stop"),
  streamId: z.string(),
});

/**
 * Run a shell command on the box, as root, and say what it printed.
 *
 * The same power the pre/post-install hooks already have — `sh -c`, root,
 * whatever the operator typed — just invoked by hand instead of around an
 * install. It is meant for the scanner-wrangling one-liners (`am force-stop`,
 * `am startservice`) that otherwise need adb and a trip to the box.
 */
export const execCommandSchema = z.object({
  type: z.literal("exec_command"),
  commandId: z.string(),
  command: z.string().min(1),
  timeoutSeconds: z.number().int().positive().default(60),
});

/**
 * Names the agent puts in `hello.capabilities`.
 *
 * Still `write_config` after the message of that name was removed: it says the
 * agent can write a config file at all, which is what the hub checks before
 * attaching one to an install. Renaming it would make every already-deployed
 * agent look incapable until it updated.
 */
export const CAPABILITY_WRITE_CONFIG = "write_config";

/**
 * What a group's config template may substitute.
 *
 * An allow-list and not a reach into the device row by key: the row holds
 * `tokenHash`, and a template able to name it would be a way to write the
 * fleet's credentials into a file the scanner reads.
 *
 * The dashboard keeps its own copy in `apps/web/src/lib/config-placeholders.ts`
 * rather than importing this. It cannot: this module is every zod schema in the
 * protocol, and the dashboard needs the list in a client component. Change one,
 * change the other.
 */
export const CONFIG_PLACEHOLDERS = [
  "device.id",
  "device.name",
  "device.serial",
  "device.model",
  "device.manufacturer",
  "device.androidVersion",
  "device.abi",
  "device.localIp",
  "device.publicIp",
  "device.rotomOrigin",
  "device.rotomDeviceId",
  // How many workers the box is configured for, off its Redroid instance row.
  // Null on a box that is not a container, and the renderer refuses a null
  // rather than substituting an empty string -- the same rule every other
  // placeholder follows, and the reason a group mixing containers with real
  // hardware finds out at the deploy that names the box.
  "device.workers",
  "group.name",
] as const;
export type ConfigPlaceholder = (typeof CONFIG_PLACEHOLDERS)[number];

export const pingSchema = z.object({ type: z.literal("ping") });

/**
 * Bring the containers on a machine in line with what the hub wants.
 *
 * The hub renders the compose file and sends its bytes, rather than sending a
 * desired set for the machine to render. Two reasons: the rendered file is then
 * the auditable artifact and the same on every machine, and the hub can compare
 * a fresh render against the sha256 the host read back off disk to decide
 * whether a converge is needed at all. That comparison is why the render has to
 * be a pure function of the instance rows — anything conditional in it turns a
 * reconnect into a container recreate.
 *
 * Carries the whole desired set every time, never a delta. That makes it
 * idempotent, makes drift self-correcting, and means a machine that missed one
 * catches up on the next rather than needing a replay.
 */
export const hostConvergeSchema = z.object({
  type: z.literal("host_converge"),
  /** Correlates the result, since a converge outlives the beat that asked. */
  requestId: z.string(),
  project: z.string(),
  dir: z.string(),
  /** The rendered compose file. */
  compose: z.string(),
  /**
   * How many containers may be started at once.
   *
   * `docker compose up` starts every service simultaneously, and ten Androids
   * coming up together on sixteen cores is the OOM the sizing advice warns
   * about. Low by default; it only costs time on a first provisioning.
   */
  batchSize: z.number().int().positive().default(2),
  /**
   * Whether containers under the project that the file does not name may be
   * removed.
   *
   * False until a machine has converged once. A machine running the
   * hand-written compose file has containers holding real device identities,
   * and an empty desired set would make every one of them an orphan.
   */
  removeOrphans: z.boolean().default(false),
});
export type HostConverge = z.infer<typeof hostConvergeSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  welcomeSchema,
  installJobSchema,
  cancelJobSchema,
  rebootSchema,
  agentUpdateSchema,
  collectLogsSchema,
  logStreamStartSchema,
  logStreamStopSchema,
  execCommandSchema,
  pingSchema,
  hostConvergeSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// ---------------------------------------------------------------------------
// Enrollment (plain HTTP, before the socket exists)
// ---------------------------------------------------------------------------

export const enrollRequestSchema = z.object({
  enrollmentToken: z.string().min(1),
  /** Optional friendly name; falls back to manufacturer + model + serial tail. */
  name: z.string().nullish(),
  agentVersion: z.string(),
  device: deviceInfoSchema,
});

export const enrollResponseSchema = z.object({
  deviceId: z.string(),
  deviceToken: z.string(),
  name: z.string(),
  approved: z.boolean(),
  wsUrl: z.string(),
});
export type EnrollResponse = z.infer<typeof enrollResponseSchema>;
