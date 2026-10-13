import "server-only";

/**
 * Client for the hub's /internal API. Reads go straight to the database from
 * the server components; this is only for the things that need a live socket or
 * the scheduler — starting a rollout, cancelling a job, rebooting a box.
 */
const HUB_URL = process.env.HUB_URL ?? "http://localhost:3001";
const SECRET = process.env.HUB_INTERNAL_SECRET ?? "";

export class HubError extends Error {}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${HUB_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-magnemite-secret": SECRET,
      },
      body: JSON.stringify(body ?? {}),
      cache: "no-store",
    });
  } catch (err) {
    throw new HubError(
      `The hub is not reachable at ${HUB_URL}. Is the hub container running? (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }

  const text = await res.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new HubError(
      typeof payload.error === "string" ? payload.error : `hub: HTTP ${res.status}`,
    );
  }
  return payload as T;
}

/**
 * Which of a rollout's hooks may run.
 *
 * NORMAL is the usual pair. POST_ONLY is a box with nothing running yet: there
 * is nothing to stop, but the hook that starts the scanner still has work.
 * NONE is the deploy that lands before the thing the hooks act on exists.
 */
export type HookMode = "NORMAL" | "POST_ONLY" | "NONE";

export type CreateRolloutInput = {
  appVersionId: string;
  deviceIds?: string[];
  forceClean?: boolean;
  /** Override the device group's hooks for this rollout only. */
  preInstallHook?: string | null;
  postInstallHook?: string | null;
  /** Which of the resolved hooks may run. Defaults to both. */
  hookMode?: HookMode;
  /** False leaves the group's MITM config alone. Defaults to writing it. */
  writeConfig?: boolean;
  /** Override the device group's MITM config for this rollout only. */
  mitmConfig?: string | null;
  canaryCount?: number;
  soakMinutes?: number;
  retryBackoffSeconds?: number;
  maxConcurrency?: number | null;
  maxAttempts?: number;
  skipUpToDate?: boolean;
  createdById?: string | null;
  note?: string | null;
};

/** What the hub could tell about a link without downloading it. */
export type RemoteProbe = {
  url: string;
  status: number;
  sizeBytes: number | null;
  contentType: string | null;
  filename: string;
  viaRange: boolean;
};

/** A build the hub has stored, however it arrived. */
export type StoredBuild = {
  appVersionId: string;
  appTargetId: string;
  packageName: string;
  version: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  wrapped: boolean;
  detected: boolean;
};

/** Mirrors the shape built by the hub's services/health.ts. */
export type IntegrationState = "OK" | "DEGRADED" | "DOWN" | "OFF";

export type IntegrationCheck = {
  key: string;
  label: string;
  summary: string;
  state: IntegrationState;
  latencyMs: number | null;
  facts: { label: string; value: string }[];
  detail: string | null;
  link: string | null;
};

export type HubHealth = {
  checkedAt: string;
  overall: IntegrationState;
  checks: IntegrationCheck[];
};

/** What the hub will pass through to Rotom. `delete` is deliberately not here. */
export type RotomDeviceAction = "restart" | "reboot" | "disconnect" | "enable" | "disable";

/**
 * One Rotom worker, as the hub read it a moment ago.
 *
 * Everything is optional because Rotom fills it in by mode: request rates exist
 * only where it measures them, and the controller block only while a worker is
 * allocated. Absent is "Rotom did not say", never zero.
 */
export type RotomWorkerView = {
  id: string;
  origin?: string | null;
  version_name?: string | null;
  platform?: string | null;
  weight?: number | null;
  is_connected?: boolean | null;
  is_in_use?: boolean | null;
  can_be_used?: boolean | null;
  last_seen_at_ms?: number | null;
  time_windowed_stats?: {
    requests_rate_over_1_min?: number | null;
    requests_rate_over_5_min?: number | null;
    request_ms_avg_over_5_min?: number | null;
  } | null;
  session?: {
    controller?: {
      id?: string | null;
      user_agent?: string | null;
      account_username?: string | null;
      account_source?: string | null;
    } | null;
  } | null;
};

export const hub = {
  status: () =>
    call<{ online: number; onlineDeviceIds: string[]; maxConcurrentJobs: number }>(
      "/internal/status",
    ),
  createRollout: (input: CreateRolloutInput) =>
    call<{ id: string; jobs: number }>("/internal/rollouts", input),
  cancelRollout: (id: string) => call(`/internal/rollouts/${id}/cancel`),
  resumeRollout: (id: string) => call(`/internal/rollouts/${id}/resume`),
  retryFailed: (id: string) => call<{ retried: number }>(`/internal/rollouts/${id}/retry-failed`),
  retryJob: (id: string) => call(`/internal/jobs/${id}/retry`),
  cancelJob: (id: string) => call(`/internal/jobs/${id}/cancel`),
  rebootDevice: (id: string) => call(`/internal/devices/${id}/reboot`),
  /**
   * Ask a box for its logs. This one waits: the hub holds the request open
   * until the zip lands, so the caller comes straight back with something to
   * download. Two minutes at worst, and then it fails.
   */
  collectDeviceLogs: (id: string, requestedById: string | null) =>
    call<{ bundleId: string }>(`/internal/devices/${id}/logs`, { requestedById }),
  /** Run a command on the box, as root, and get back what it printed. */
  execOnDevice: (id: string, command: string, timeoutSeconds?: number) =>
    call<{ ok: boolean; output: string; error: string | null }>(`/internal/devices/${id}/exec`, {
      command,
      timeoutSeconds,
    }),
  /** Rotom-side control: restart or reboot the box, drop its connection, or
   *  take it in/out of the pool. All of them travel Rotom's socket, so they are
   *  the ones that still work when the agent is the half that died. */
  rotomDeviceAction: (id: string, action: RotomDeviceAction) =>
    call(`/internal/devices/${id}/rotom/${action}`),
  /**
   * One box's workers, as the hub's last fleet sync saw them. Held in the hub's
   * memory, not stored and not re-fetched from Rotom — `readAt` is when that
   * sync ran, or null if it has not reached the box yet.
   */
  rotomWorkers: (id: string) =>
    call<{ workers: RotomWorkerView[]; readAt: number | null }>(
      `/internal/devices/${id}/rotom/workers`,
    ),
  rotomSync: () => call<{ seen: number; matched: number }>("/internal/rotom/sync"),
  /** Push a changed tracked-package list to every connected box. */
  refreshTrackedPackages: () => call<{ sent: number }>("/internal/tracked-packages/refresh"),
  cacheVersion: (id: string) => call(`/internal/versions/${id}/cache`),
  pruneVersions: (keepLatest?: number) =>
    call<{ removed: number }>("/internal/versions/prune", { keepLatest }),
  /**
   * Tell the hub its cached settings are stale.
   *
   * `pushed` is how many boxes were handed a fresh `welcome` — non-zero only
   * when the save changed the heartbeat, which is the one knob that lives on
   * them. Optional because a hub from an older deploy does not send it.
   */
  refreshSettings: () => call<{ ok: boolean; pushed?: number }>("/internal/settings"),
  /** Prove every configured channel, ignoring the level filters and the dedupe window. */
  testAlert: () =>
    call<{ ok: boolean; error: string | null; detail: string | null }>("/internal/monitor/test"),
  /** Force an evaluation pass rather than waiting for the next tick. */
  runMonitor: () => call<{ ok: boolean }>("/internal/monitor/run"),
  pollSources: () =>
    call<{
      ran: boolean;
      targets: number;
      feeds: number;
      listed: number;
      discovered: number;
      errors: { feed: string; error: string }[];
    }>("/internal/sources/poll"),
  /**
   * Ask the far end about a build URL without downloading it. Cheap enough to
   * run while somebody is still typing the link.
   */
  probeBuildUrl: (url: string) => call<RemoteProbe>("/internal/uploads/probe", { url }),
  /**
   * Fetch a published build straight onto the artifacts volume, skipping the
   * browser and every proxy between it and here — which is what makes this the
   * way past a 413 on a large bundle.
   */
  importBuildFromUrl: (input: { url: string; packageName?: string; filename?: string }) =>
    call<StoredBuild>("/internal/uploads/from-url", input),
  /** Integration probes for the Status page. `force` skips the hub's cache. */
  health: (force = false) => call<HubHealth>("/internal/health", { force }),

  /**
   * Bring a machine to N containers and converge it.
   *
   * One call because pressing Save means both: the rows are the desired state
   * and the dashboard could write them itself, but nothing would then reach the
   * machine, and "I changed the number and nothing happened" would be the
   * normal experience.
   */
  /**
   * `memLimitBytes` undefined leaves the machine's override alone; null clears
   * it back to the fleet-wide setting.
   */
  scaleHost: (id: string, count: number, workers: number | null, memLimitBytes?: number | null) =>
    call<{ added: number; removed: number; sent: boolean; reason?: string }>(
      `/internal/hosts/${id}/scale`,
      { count, workers, ...(memLimitBytes === undefined ? {} : { memLimitBytes }) },
    ),
  /**
   * Import the containers a machine already has.
   *
   * Nothing is converged before this, because a machine running a hand-written
   * compose file has containers holding real device identities and an empty
   * desired set would make every one of them an orphan.
   */
  adoptHost: (id: string) => call<{ adopted: number }>(`/internal/hosts/${id}/adopt`),
  /**
   * Provision a machine over SSH and bring it to N containers.
   *
   * Returns as soon as the run starts: the SSH half is minutes, and the row it
   * creates carries the progress. The credential goes no further than this
   * call — it is used once and stored nowhere.
   */
  bootstrapHost: (input: {
    name: string;
    host: string;
    port?: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    desiredInstances: number;
    desiredWorkers: number | null;
    desiredGroupId: string | null;
    desiredNameTemplate: string | null;
  }) => call<{ id: string; serial: string }>("/internal/hosts/bootstrap", input),
  /** Re-send the file. `force` sends it even when the hash already matches. */
  convergeHost: (id: string, force = false) =>
    call<{ sent: boolean; reason?: string }>(`/internal/hosts/${id}/converge`, { force }),
  /** Re-run the provisioning script, with the files that build the image. */
  rerunBootstrap: (id: string) =>
    call<{ sent: boolean; reason?: string }>(`/internal/hosts/${id}/bootstrap`, {}),
  /**
   * Give a box what its group hands every new box.
   *
   * Enrolment already does this. This is for a box that enrolled on a token
   * without auto-approve: it was pending then, so nothing was queued, and the
   * moment it becomes a rollout target is the moment somebody approves it.
   */
  queueJoinInstalls: (id: string) =>
    call<{ queued: number }>(`/internal/devices/${id}/join-installs`, {}),
};

export const HUB_BASE_URL = HUB_URL;
export const HUB_SECRET = SECRET;
