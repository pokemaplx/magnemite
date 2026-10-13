"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  FileJson,
  Link2,
  Package,
  Rss,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import {
  checkBuildUrl,
  deleteManualVersion,
  importBuildFromUrl,
  startManualInstall,
} from "@/actions/manual";
import type { HookMode } from "@/lib/hub";
import { readApkInfoFromFile, type ApkInfo } from "@/lib/apk-info";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input, Textarea } from "@/components/ui/input";
import { checkConfigTemplate } from "@/lib/config-placeholders";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { SearchInput } from "@/components/ui/search-input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSortHead,
} from "@/components/ui/table";
import { OnlineDot } from "@/components/status";
import { formatBytes } from "@/lib/format";
import type { MitmColumn } from "@/lib/mitm-columns";
import { RelativeTime } from "@/components/relative-time";
import { useTableSort } from "@/lib/table-sort";
import { cn } from "@/lib/utils";

export type FleetPackage = {
  packageName: string;
  displayName: string | null;
  devices: number;
  /**
   * A MITM some device group runs. These lead the picker: on a fresh fleet the
   * one app you most need to install is the one no box has reported yet, so
   * ordering by "how many boxes have it" buries it.
   */
  isMitm?: boolean;
};

/**
 * The three answers to "is there anything for these hooks to act on".
 *
 * Named for what happens rather than for the phase of a project: "initial
 * setup" makes the reader work out which hooks that implies, and gets it wrong
 * on the half of a fresh fleet where the post-install hook is the one thing
 * that matters.
 */
const HOOK_MODES: { id: HookMode; label: string; hint: string }[] = [
  { id: "NORMAL", label: "Normal", hint: "Stop before, start after." },
  { id: "POST_ONLY", label: "Start only", hint: "New box: nothing to stop yet." },
  { id: "NONE", label: "Neither", hint: "Nothing here is running yet." },
];

export type ManualDevice = {
  id: string;
  name: string;
  serial: string;
  online: boolean;
  groupId: string | null;
  groupName: string | null;
  model: string | null;
  androidVersion: string | null;
  freeBytes: number | null;
  lastSeenAt: string | null;
  /** Reported version per package, for the "currently on" column. */
  installed: Record<string, string>;
};

export type ManualBuild = {
  id: string;
  packageName: string;
  displayName: string;
  version: string;
  arch: string;
  sizeBytes: number;
  sha256: string | null;
  uploadedAt: string;
  /**
   * The version source that listed it, or null for an upload.
   *
   * One type for both, because downstream they are the same thing: an
   * `appVersionId` and an ordinary rollout. It only changes what the row says
   * and whether it can be deleted here -- a feed's build is managed in
   * Settings, and forgetting one would just have the feed list it again.
   */
  feed: string | null;
};

type Group = {
  id: string;
  name: string;
  preInstallHook: string | null;
  postInstallHook: string | null;
  mitmPackageName: string | null;
  mitmConfigPath: string | null;
  /** Null for a viewer, who has no override to seed — see the manual page. */
  mitmConfig: string | null;
};

const CUSTOM = "__custom__";

/**
 * Install or update an APK you have in your hand, on boxes you choose.
 *
 * Everything else in Magnemite is about the one watched app and the versions a
 * source publishes for it. This is the escape hatch — a scanner build that is
 * not on the mirror yet, a launcher, a config app — and it deliberately ends
 * up in the same place: a normal rollout, with the same jobs and the same page
 * to watch it fail or finish on.
 *
 * Installing onto a box that has nothing has always worked: a device with no
 * reported version gets a normal queued job. What it never did was *say* so,
 * and the one app a fresh box most needs was the hardest to pick, because the
 * list was built from what boxes already had.
 */
export function ManualInstall({
  packages,
  devices,
  groups,
  builds,
  feedBuilds,
  uncachedByPackage,
  mitmColumns,
  canOperate,
}: {
  packages: FleetPackage[];
  devices: ManualDevice[];
  groups: Group[];
  builds: ManualBuild[];
  /** What the version sources have listed and cached. */
  feedBuilds: ManualBuild[];
  /** Per package, how many a source listed but has not cached yet. */
  uncachedByPackage: Record<string, number>;
  mitmColumns: MitmColumn[];
  canOperate: boolean;
}) {
  const router = useRouter();

  // --- what to install ----------------------------------------------------
  const [choice, setChoice] = useState(packages[0]?.packageName ?? CUSTOM);
  const [customPackage, setCustomPackage] = useState("");
  const packageName = choice === CUSTOM ? customPackage.trim() : choice;

  const [file, setFile] = useState<File | null>(null);
  // What the file says about itself, read in the browser by the same parser
  // the hub runs on the upload. Null while it is being read.
  const [info, setInfo] = useState<ApkInfo | null>(null);
  const [reading, setReading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ManualBuild | null>(null);

  // --- where it goes ------------------------------------------------------
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // --- how ----------------------------------------------------------------
  const [preHook, setPreHook] = useState("");
  const [postHook, setPostHook] = useState("");
  const [forceClean, setForceClean] = useState(false);
  // Off, unlike the fleet's deploy form. The commonest manual deploy is the
  // same version again — a build that was wrong, rebuilt — and the version
  // string cannot tell those two apart, so skipping is the answer to a
  // different question than the one usually being asked here.
  const [skipUpToDate, setSkipUpToDate] = useState(false);
  // Follows the suggestion until somebody picks for themselves, and then stops
  // moving. A control that kept re-deciding under the cursor as boxes are
  // ticked would be worse than one that never suggested anything.
  const [hookMode, setHookMode] = useState<HookMode>("NORMAL");
  const [hookModeTouched, setHookModeTouched] = useState(false);
  // On by default: writing the config is the point of deploying a MITM, and
  // there is no other way for an edited one to reach the boxes.
  const [writeConfig, setWriteConfig] = useState(true);
  /**
   * The config this deploy writes instead of each box's group one.
   *
   * `null` is "the group's", which is what every deploy did before this
   * existed and what almost every deploy still wants. A string means this
   * rollout carries its own — stored on the rollout, so a retry hours later
   * writes the same thing rather than whatever the group says by then.
   */
  const [configOverride, setConfigOverride] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  /**
   * Exactly what was last seeded in, so the box can keep following the device
   * selection until somebody types.
   *
   * It has to: this card sits above the three steps, so the override is opened
   * before any box is picked — and which group's config to start from is a
   * question only the picked boxes can answer. Without this it would seed from
   * the tie-break and never look again.
   *
   * The comparison against the text is what makes it safe. The first keystroke
   * makes them differ, and from then on nothing overwrites what was typed.
   */
  const [seededText, setSeededText] = useState<string | null>(null);
  const [note, setNote] = useState("");

  // --- from a link ---------------------------------------------------------
  // The second way a build arrives. An upload has to fit through the browser
  // and every proxy in front of the dashboard; a link is fetched by the hub,
  // which is what gets a 250 MB bundle past a 100 MB body limit.
  const [source, setSource] = useState<"file" | "url" | "feed">("file");
  const [url, setUrl] = useState("");
  const [checking, setChecking] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [probe, setProbe] = useState<{
    url: string;
    sizeBytes: number | null;
    contentType: string | null;
    filename: string;
  } | null>(null);

  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // The "are you sure" for a deploy that also rewrites configs. Its own error
  // slot: a failure has to be readable without the dialog closing over it.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const buildsForPackage = useMemo(
    () => (packageName ? builds.filter((b) => b.packageName === packageName) : builds),
    [builds, packageName],
  );
  const feedForPackage = useMemo(
    () => (packageName ? feedBuilds.filter((b) => b.packageName === packageName) : feedBuilds),
    [feedBuilds, packageName],
  );
  const uncachedHere = packageName ? (uncachedByPackage[packageName] ?? 0) : 0;

  // The MITM columns, minus one that would duplicate the "currently on" column
  // when the thing being installed is itself a MITM.
  const extraColumns = useMemo(
    () => mitmColumns.filter((column) => column.packageName !== packageName),
    [mitmColumns, packageName],
  );

  // Sorted like the fleet table, because this is the fleet — the question
  // "which boxes" is the same one, asked while holding a file. Keys are open
  // rather than a closed union for the same reason they are there: one
  // `pkg:<name>` per MITM column.
  const accessors = useMemo(() => {
    const map: Record<string, (d: ManualDevice) => string | number | null> = {
      device: (d) => d.name,
      group: (d) => d.groupName,
      version: (d) => (packageName ? (d.installed[packageName] ?? null) : null),
      free: (d) => d.freeBytes,
      lastSeen: (d) => d.lastSeenAt,
    };
    for (const column of extraColumns) {
      map[`pkg:${column.packageName}`] = (d) => d.installed[column.packageName] ?? null;
    }
    return map;
  }, [packageName, extraColumns]);

  const { headProps, sortRows } = useTableSort<string, ManualDevice>(accessors, {
    key: "device",
    direction: "asc",
  });

  const visibleDevices = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = devices.filter((device) => {
      if (groupFilter && device.groupId !== groupFilter) return false;
      if (!q) return true;
      return (
        device.name.toLowerCase().includes(q) ||
        device.serial.toLowerCase().includes(q) ||
        (device.model?.toLowerCase().includes(q) ?? false) ||
        (device.groupName?.toLowerCase().includes(q) ?? false) ||
        // Any reported version, not only the chosen package's: with the MITM
        // columns on screen, typing a version you can see has to find its rows.
        Object.values(device.installed).some((version) => version.toLowerCase().includes(q))
      );
    });
    return sortRows(filtered);
  }, [devices, query, groupFilter, sortRows]);

  /**
   * How the picked set splits between boxes that have this app and boxes that
   * do not. The whole point of the page saying "install" rather than "update".
   */
  const split = useMemo(() => {
    const chosen = devices.filter((device) => picked.has(device.id));
    const fresh = packageName
      ? chosen.filter((device) => !device.installed[packageName]).length
      : chosen.length;
    // Boxes reporting exactly the version being installed. The same comparison
    // the hub makes when skipping, so the number here is the number of jobs
    // that would come out SKIPPED.
    const same =
      packageName && selected
        ? chosen.filter((device) => device.installed[packageName] === selected.version).length
        : 0;
    return { total: chosen.length, fresh, updates: chosen.length - fresh, same };
  }, [devices, picked, packageName, selected]);

  /** Groups whose MITM is the app being installed — the ones whose config rides along. */
  const configuredGroups = useMemo(
    () => (packageName ? groups.filter((g) => g.mitmPackageName === packageName) : []),
    [groups, packageName],
  );

  /** Where the override lands, which is still each group's own path. */
  const configPaths = useMemo(() => {
    const paths = [...new Set(configuredGroups.map((g) => g.mitmConfigPath).filter(Boolean))];
    return paths.length > 0 ? paths.join(", ") : "the group's config path";
  }, [configuredGroups]);

  /**
   * What an override starts from, which is always a real config when there is
   * one to start from.
   *
   * Editing is the point: an operator opening this wants the group's file with
   * one value different, not an empty box and a JSON document to retype. So
   * the only question is *whose*, and that is only a question when the deploy
   * spans groups whose configs differ — then it seeds from the one covering
   * the most of the picked boxes, and says so underneath, rather than leaving
   * the work to be done from scratch over a difference that is usually a line.
   */
  const overrideSeed = useMemo(() => {
    const withConfig = configuredGroups.filter((group) => Boolean(group.mitmConfig));
    if (withConfig.length === 0) return { text: "", from: null as string | null, others: 0 };

    const counted = withConfig.map((group) => ({
      group,
      boxes: devices.filter((d) => picked.has(d.id) && d.groupId === group.id).length,
    }));
    // Most boxes first, and by name after that so the same deploy always
    // starts from the same place rather than on whichever order a query
    // happened to return.
    counted.sort((a, b) => b.boxes - a.boxes || a.group.name.localeCompare(b.group.name));
    const winner = counted[0]!.group;
    const distinct = new Set(withConfig.map((group) => group.mitmConfig)).size;
    return { text: winner.mitmConfig!, from: winner.name, others: distinct - 1 };
  }, [configuredGroups, devices, picked]);

  useEffect(() => {
    if (configOverride === null || configOverride !== seededText) return;
    if (overrideSeed.text === seededText) return;
    setConfigOverride(overrideSeed.text);
    setSeededText(overrideSeed.text);
  }, [overrideSeed.text, configOverride, seededText]);

  /**
   * How many of the picked boxes actually have a config written, which is not
   * the same as how many are being installed on: only the boxes in a group
   * whose MITM this is. A deploy of 40 boxes that rewrites 6 configs should
   * say 6.
   */
  const configWriteCount = useMemo(() => {
    if (configuredGroups.length === 0) return 0;
    const ids = new Set(configuredGroups.map((g) => g.id));
    return devices.filter((d) => picked.has(d.id) && d.groupId && ids.has(d.groupId)).length;
  }, [configuredGroups, devices, picked]);

  /**
   * Writing a config is the one part of a manual deploy that overwrites
   * something already on the box, and unlike the install it has no previous
   * version to go back to — the file it replaces existed only there. The
   * switch above is on by default, which is right, and is also exactly why
   * this asks before the write rather than after.
   */
  const needsConfirm = configuredGroups.length > 0 && writeConfig && configWriteCount > 0;

  /**
   * Which hooks this deploy should be allowed to run, worked out rather than
   * asked for.
   *
   * The hooks are written to stop and start the group's MITM, and whether that
   * is the right thing to do depends on whether the MITM is on the box yet.
   * Setting a fleet up is two deploys where the answer differs: the watched app
   * first, onto boxes with no scanner at all, and then the MITM itself, where
   * there is still nothing to stop but the hook that starts it finally has
   * something to start.
   *
   * A guess, and overridable, because a hook is arbitrary shell: this reads
   * "the group's MITM is installed" as "the hooks have something to act on",
   * which is the convention the presets follow rather than a rule anyone is
   * held to.
   */
  const mitmByGroup = useMemo(
    () => new Map(groups.map((g) => [g.id, g.mitmPackageName])),
    [groups],
  );
  const suggestedHookMode: HookMode = useMemo(() => {
    if (!packageName || picked.size === 0) return "NORMAL";
    const chosen = devices.filter((device) => picked.has(device.id));
    const anyScannerPresent = chosen.some((device) => {
      const mitm = device.groupId ? mitmByGroup.get(device.groupId) : null;
      return Boolean(mitm && device.installed[mitm]);
    });
    if (anyScannerPresent) return "NORMAL";
    // Nothing to stop on any of them. Whether there is anything worth starting
    // afterwards depends on whether this deploy is what puts it there.
    return configuredGroups.length > 0 ? "POST_ONLY" : "NONE";
  }, [packageName, picked, devices, mitmByGroup, configuredGroups]);

  const effectiveHookMode = hookModeTouched ? hookMode : suggestedHookMode;

  const allVisiblePicked =
    visibleDevices.length > 0 && visibleDevices.every((d) => picked.has(d.id));
  const someVisiblePicked = visibleDevices.some((d) => picked.has(d.id));

  function toggleAllVisible() {
    setPicked((prev) => {
      const next = new Set(prev);
      if (allVisiblePicked) visibleDevices.forEach((d) => next.delete(d.id));
      else visibleDevices.forEach((d) => next.add(d.id));
      return next;
    });
  }

  function toggleDevice(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * Read the manifest as soon as a file is chosen. Only a few kilobytes are
   * touched — the zip's tail and the one entry holding the manifest — so this
   * costs nothing even on a 250 MB bundle.
   */
  function chooseFile(picked: File | null) {
    setFile(picked);
    setUploadError(null);
    setInfo(null);
    if (!picked) return;

    setReading(true);
    void readApkInfoFromFile(picked)
      .then((read) => setInfo(read))
      .finally(() => setReading(false));
  }

  function clearFile() {
    setFile(null);
    setInfo(null);
    setUploadError(null);
    // The input keeps its own value, so without this the same file cannot be
    // chosen again — the change event never fires for an unchanged path.
    if (fileInput.current) fileInput.current.value = "";
  }

  /**
   * Fetch it, store it, and select it — the link's answer to Upload.
   *
   * Two calls behind one button. The first is a HEAD, which costs nothing and
   * fails fast on the mistakes that are worth failing fast on: a dead link, a
   * typo, a page that returns HTML. Only then is a few hundred megabytes
   * committed to, and what the HEAD learned — the name, the size — is on
   * screen while that download runs, which is the only progress there is to
   * show for a transfer happening on the hub.
   */
  function importLink() {
    setUploadError(null);
    setProbe(null);
    setChecking(true);

    void (async () => {
      const check = await checkBuildUrl(url).finally(() => setChecking(false));
      if (check.error) {
        setUploadError(check.error);
        return;
      }
      setProbe(check.probe ?? null);

      setFetching(true);
      await importBuildFromUrl({ url, packageName: packageName || undefined })
        .then((result) => {
          if (result.error || !result.build) {
            setUploadError(result.error ?? "The hub did not store that build.");
            return;
          }
          setSelected({
            id: result.build.appVersionId,
            packageName: result.build.packageName,
            displayName: result.build.packageName.split(".").pop() ?? "",
            version: result.build.version,
            arch: "arm64-v8a",
            sizeBytes: result.build.sizeBytes,
            sha256: result.build.sha256,
            uploadedAt: new Date().toISOString(),
            // Fetched by the hub from a link, which is still an upload as far
            // as this form is concerned: it is ours to forget.
            feed: null,
          });
          setProbe(null);
          setUrl("");
          router.refresh();
        })
        .finally(() => setFetching(false));
    })();
  }

  /**
   * XHR rather than fetch: this is the one request in the app where the
   * operator needs to watch a progress bar, and `fetch` still cannot report
   * upload progress.
   */
  function upload() {
    if (!file) return;
    setUploadError(null);
    setUploadPct(0);

    // The version always comes out of the file's own manifest — it is the one
    // thing about a build nobody should be able to mistype. The package name
    // stays a hint the hub falls back on when the manifest does not name one.
    const query = new URLSearchParams({ filename: file.name });
    if (packageName) query.set("packageName", packageName);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/manual/upload?${query.toString()}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) setUploadPct(Math.round((event.loaded / event.total) * 100));
    };

    xhr.onload = () => {
      setUploadPct(null);
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        payload = {};
      }

      if (xhr.status >= 400) {
        setUploadError((payload.error as string) ?? `Upload failed (HTTP ${xhr.status})`);
        return;
      }

      setSelected({
        id: payload.appVersionId as string,
        packageName: payload.packageName as string,
        displayName: (payload.packageName as string).split(".").pop() ?? "",
        version: payload.version as string,
        arch: "arm64-v8a",
        sizeBytes: Number(payload.sizeBytes ?? 0),
        sha256: (payload.sha256 as string) ?? null,
        uploadedAt: new Date().toISOString(),
        feed: null,
      });
      clearFile();
      router.refresh();
    };

    xhr.onerror = () => {
      setUploadPct(null);
      setUploadError("The upload did not reach the server.");
    };

    xhr.send(file);
  }

  /**
   * Starts the rollout and navigates on success. Returns the message to show
   * when it fails, because the two callers show it in different places: the
   * button at the top of the page, the dialog inside itself.
   */
  async function runInstall(): Promise<string | null> {
    if (!selected) return null;

    // Checked here and not only on the server, because the server's answer
    // arrives after the rollout would have started — and because this is the
    // same check the group's own config goes through, from the same function.
    if (configOverride !== null) {
      const bad = configOverride.trim()
        ? checkConfigTemplate(configOverride)
        : "Write the config, or switch back to the group's — an empty one would write nothing.";
      if (bad) {
        setConfigError(bad);
        return bad;
      }
    }

    const result = await startManualInstall({
      appVersionId: selected.id,
      deviceIds: [...picked],
      preInstallHook: preHook.trim() || null,
      postInstallHook: postHook.trim() || null,
      hookMode: effectiveHookMode,
      writeConfig,
      mitmConfig: configOverride,
      forceClean,
      skipUpToDate,
      maxConcurrency: null,
      note: note.trim() || null,
    });

    if (result.error) return result.error;
    router.push(`/rollouts/${result.rolloutId}`);
    return null;
  }

  /** The button. Asks first when this deploy also rewrites configs. */
  function install() {
    if (!selected) return;
    setError(null);

    if (needsConfirm) {
      setConfirmError(null);
      setConfirmOpen(true);
      return;
    }

    startTransition(async () => {
      const message = await runInstall();
      if (message) setError(message);
    });
  }

  function confirmInstall() {
    setConfirmError(null);
    startTransition(async () => {
      const message = await runInstall();
      // Left open on failure so the reason is read where the decision was
      // made, the same as every other confirmation on the dashboard.
      if (message) setConfirmError(message);
      else setConfirmOpen(false);
    });
  }

  function remove(build: ManualBuild) {
    startTransition(async () => {
      const result = await deleteManualVersion(build.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (selected?.id === build.id) setSelected(null);
      router.refresh();
    });
  }

  const uploading = uploadPct !== null;
  const canUpload = Boolean(file) && !uploading && canOperate;
  // The version the hub will store, since it parses the same bytes.
  const detectedVersion = info?.versionName ?? info?.versionCode ?? null;

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Manual deploy</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Push an APK you have on hand to boxes you pick! Made for an app no source is watched for,
          or a build that is not published yet. It runs as a normal rollout.
        </p>
      </header>

      {!canOperate ? (
        <p className="rounded-lg border border-border bg-subtle px-3 py-2 text-sm text-muted-foreground">
          Your account is read-only, so uploading and installing are disabled.
        </p>
      ) : null}

      {error ? (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      ) : null}

      {/* The config is the half of a MITM deploy that is easy not to think
          about, so it says so before the file is even chosen rather than in a
          line under the hooks, three cards down and after the decision. */}
      {configuredGroups.length > 0 ? (
        <div
          className={cn(
            "flex flex-col gap-3 rounded-lg border px-4 py-3",
            writeConfig ? "border-primary/40 bg-primary/5" : "border-border bg-subtle",
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-2">
              <FileJson className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="text-sm">
                <span className="font-medium">
                  This is the MITM for {configuredGroups.map((g) => g.name).join(", ")}.
                </span>{" "}
                <span className="text-muted-foreground">
                  {writeConfig
                    ? "Each box there also gets its group's config written once the install verifies, before the hook that starts it. Disable this to leave the config as is."
                    : "The config on each box is left exactly as it is. The app is installed and nothing else is touched."}
                </span>
              </div>
            </div>
            <Switch
              checked={writeConfig}
              onCheckedChange={setWriteConfig}
              disabled={!canOperate}
              aria-label="Write the group's config with this deploy"
            />
          </div>
          {!writeConfig ? (
            <p className="text-xs text-muted-foreground">
              For the deploy that must not overwrite what is already there: reinstalling a scanner
              that crashed, rolling a build back, or shipping a hotfix over a config somebody edited
              on the box by hand.
            </p>
          ) : null}

          {/* The override. Behind one click rather than always open, because
              the group's config is the right answer almost every time and a
              textarea full of JSON invites being edited when nothing needed
              changing. */}
          {writeConfig && canOperate ? (
            configOverride === null ? (
              <button
                type="button"
                onClick={() => {
                  setConfigOverride(overrideSeed.text);
                  setSeededText(overrideSeed.text);
                }}
                className="self-start text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                Use a different config for this deploy…
              </button>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium">This deploy&apos;s config</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setConfigOverride(null);
                      setSeededText(null);
                      setConfigError(null);
                    }}
                  >
                    Back to the group&apos;s
                  </Button>
                </div>
                <Textarea
                  value={configOverride}
                  onChange={(event) => {
                    setConfigOverride(event.target.value);
                    setConfigError(null);
                  }}
                  rows={12}
                  spellCheck={false}
                  className="font-mono text-xs"
                  aria-label="The MITM config this deploy writes"
                  placeholder={
                    overrideSeed.from
                      ? undefined
                      : "No group here has a config yet, so there was nothing to start from."
                  }
                />
                {overrideSeed.from && overrideSeed.others > 0 ? (
                  <p className="text-xs text-warning">
                    Started from <span className="font-medium">{overrideSeed.from}</span>&apos;s
                    config, the one covering most of the picked boxes.{" "}
                    {overrideSeed.others === 1
                      ? "One other group"
                      : `${overrideSeed.others} other groups`}{" "}
                    here {overrideSeed.others === 1 ? "has" : "have"} a different one, and what you
                    write replaces {overrideSeed.others === 1 ? "it" : "them"} too.
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Written to <span className="font-mono">{configPaths}</span> on{" "}
                  <span className="text-foreground">{configWriteCount}</span> box
                  {configWriteCount === 1 ? "" : "es"}, instead of{" "}
                  {configuredGroups.length === 1 ? "the group's" : "each group's"}. The path is
                  still the group&apos;s — only what goes in the file changes. Placeholders work the
                  same way, and this is kept on the rollout, so a retry hours from now writes this
                  and not whatever the group says by then.
                </p>
                {configError ? <p className="text-xs text-destructive">{configError}</p> : null}
              </div>
            )
          ) : null}
        </div>
      ) : null}

      {/* --- 1. the app ---------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>1 · Which app</CardTitle>
          <CardDescription>
            The package the APK replaces. Installing over a different signing key wipes the
            app&apos;s data. The agent falls back to uninstall-and-install and says so on the job.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="package">Package</Label>
            <Select
              id="package"
              placeholder="Select package…"
              value={choice}
              onValueChange={setChoice}
              options={[
                ...packages.map((p) => ({
                  value: p.packageName,
                  // "0 boxes" spelled out rather than left blank: on a fresh
                  // fleet that is the normal state of the app you are here to
                  // install, and an empty suffix read as missing data.
                  label: [
                    p.packageName,
                    p.isMitm ? "MITM" : null,
                    `${p.devices} ${p.devices === 1 ? "box" : "boxes"}`,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                })),
                { value: CUSTOM, label: "Another package…" },
              ]}
            />
            {choice === CUSTOM ? (
              <Input
                value={customPackage}
                onChange={(e) => setCustomPackage(e.target.value)}
                placeholder="com.example.app"
                className="mt-1 font-mono"
              />
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* --- 2. the file --------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>2 · The build</CardTitle>
          <CardDescription>
            A single <code className="font-mono">.apk</code>, or an{" "}
            <code className="font-mono">.apkm</code> / <code className="font-mono">.xapk</code>{" "}
            bundle of splits. A lone APK is wrapped into a one-entry bundle on the server, which is
            what the agent installs from.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Three ways in. The link exists because of a limit that has nothing
              to do with this app: an upload travels through the browser and
              every proxy in front of the dashboard, and one of them stops a
              body well below the size of a bundle of splits -- a link is
              fetched by the hub instead. The third is for the common case
              neither covered: the build is already here, because a version
              source listed it and cached it, and the only thing missing was a
              way to pick it without a rollout. */}
          <div className="flex w-fit rounded-lg border border-border bg-subtle p-0.5">
            {(
              [
                { key: "file", label: "Upload a file", icon: Upload },
                { key: "url", label: "From a link", icon: Link2 },
                { key: "feed", label: "Version sources", icon: Rss },
              ] as const
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                disabled={!canOperate || uploading || fetching}
                onClick={() => {
                  setSource(option.key);
                  setUploadError(null);
                }}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  source === option.key
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <option.icon className="h-3.5 w-3.5" />
                {option.label}
              </button>
            ))}
          </div>

          {source === "url" ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-64 flex-1 flex-col gap-1.5">
                  <Label htmlFor="build-url">Link to the build</Label>
                  <Input
                    id="build-url"
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setProbe(null);
                    }}
                    placeholder="https://example.com/builds/app-1.4.2.apkm"
                    className="font-mono text-xs"
                    disabled={!canOperate || fetching}
                  />
                </div>
                <Button
                  onClick={importLink}
                  disabled={!canOperate || !url.trim() || checking || fetching}
                >
                  <Link2 />
                  {checking ? "Checking…" : fetching ? "Fetching…" : "Fetch and store"}
                </Button>
              </div>

              {/* What the HEAD learned, held on screen while the download it
                  cleared is running. The version is not in it and cannot be:
                  that lives in the manifest inside the file, so it appears
                  when the file lands, the same as an upload's. */}
              {probe ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                  <span className="font-mono font-medium text-foreground">{probe.filename}</span>
                  <span className="text-muted-foreground">
                    {probe.sizeBytes === null ? "size not declared" : formatBytes(probe.sizeBytes)}
                  </span>
                  {probe.contentType ? (
                    <span className="font-mono text-muted-foreground">· {probe.contentType}</span>
                  ) : null}
                  {probe.url !== url.trim() ? (
                    <span className="truncate text-muted-foreground">
                      · redirects to {probe.url}
                    </span>
                  ) : null}
                  <span className="basis-full text-muted-foreground">
                    {fetching
                      ? "Downloading it onto the hub. The package and version are read from the manifest when it lands."
                      : "The package and version are read from the manifest when the file arrives, the same as an upload's."}
                  </span>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Fetched by the hub, straight onto the artifacts volume — nothing passes through
                  the browser, so no proxy body limit applies. The link is checked before anything
                  is downloaded, and a big bundle then takes as long as the download does.
                </p>
              )}
            </div>
          ) : source === "feed" ? (
            <div className="flex flex-col gap-2">
              {feedForPackage.length === 0 ? (
                <p className="rounded-lg border border-border bg-subtle px-3 py-2 text-xs text-muted-foreground">
                  {uncachedHere > 0
                    ? `A source has listed ${uncachedHere} build${uncachedHere === 1 ? "" : "s"} for this package and cached none of them. Cache one in Settings → Version sources and it appears here.`
                    : packageName
                      ? "No source has a cached build for this package. Check Settings → Version sources, or use a link or an upload."
                      : "Pick a package above to see what the sources have for it."}
                </p>
              ) : (
                <>
                  <p className="text-xs font-medium text-muted-foreground">
                    Cached by a version source
                  </p>
                  <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                    {feedForPackage.map((build) => (
                      <li
                        key={build.id}
                        className={cn(
                          "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                          selected?.id === build.id
                            ? "border-primary/40 bg-primary/5"
                            : "border-border",
                        )}
                      >
                        <Rss className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="font-mono">{build.version}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {build.feed} · {formatBytes(build.sizeBytes)} ·{" "}
                          <RelativeTime value={build.uploadedAt} />
                        </span>
                        {/* No delete here, unlike an upload: this row belongs
                            to a feed, and forgetting it would only have the
                            next poll list it again. */}
                        <Button
                          variant="outline"
                          size="sm"
                          className="ml-auto"
                          disabled={!canOperate || pending}
                          onClick={() => setSelected(build)}
                        >
                          Use this
                        </Button>
                      </li>
                    ))}
                  </ul>
                  {uncachedHere > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {uncachedHere} more listed and not cached. A build stored once is attributed
                      to the feed with the lowest priority, so a feed showing nothing here may
                      simply have lost every build to another one.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-64 flex-1 flex-col gap-1.5">
                  <Label htmlFor="file">File</Label>
                  {/* The browser's own file control cannot be sized or centred
                    reliably — its button is a pseudo-element whose metrics differ
                    per engine — so the input is hidden and a real Button drives
                    it. Same height and same styling as every other field here. */}
                  <div
                    className={cn(
                      "flex h-9 w-full items-center gap-2.5 rounded-lg border border-input bg-card pl-1.5 pr-3",
                      (!canOperate || uploading) && "opacity-40",
                    )}
                  >
                    <Button
                      asChild
                      variant="secondary"
                      size="sm"
                      className="h-7 shrink-0"
                      disabled={!canOperate || uploading}
                    >
                      <label htmlFor="file" className="cursor-pointer">
                        Choose file
                      </label>
                    </Button>
                    <span className="truncate text-sm text-muted-foreground">
                      {file ? `${file.name} · ${formatBytes(file.size)}` : "No file selected"}
                    </span>
                    {file && !uploading ? (
                      <button
                        type="button"
                        onClick={clearFile}
                        aria-label="Remove the chosen file"
                        className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    ) : null}
                  </div>
                  <input
                    id="file"
                    ref={fileInput}
                    type="file"
                    accept=".apk,.apkm,.xapk,.zip"
                    disabled={!canOperate || uploading}
                    onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
                    className="sr-only"
                  />
                </div>
                <Button onClick={upload} disabled={!canUpload}>
                  <Upload />
                  {uploading ? `Uploading ${uploadPct}%` : "Upload"}
                </Button>
              </div>
              {/* Which build this is, answered before a few hundred megabytes
                of upload rather than after — the commonest mistake here is
                picking the wrong file out of a folder of near-identical
                names. Read from the manifest, not the file name, so it is
                the version that will actually be stored. */}
              {file ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  {reading ? (
                    <span className="text-muted-foreground">Reading the manifest…</span>
                  ) : detectedVersion ? (
                    <>
                      <span className="text-muted-foreground">Version</span>
                      <span className="font-mono font-medium text-foreground">
                        {detectedVersion}
                      </span>
                      {info?.versionName && info.versionCode ? (
                        <span className="font-mono text-muted-foreground">
                          · build {info.versionCode}
                        </span>
                      ) : null}
                      {/* The package the file declares, flagged only when it
                        disagrees with the one chosen above — that mismatch
                        is the mistake worth catching. */}
                      {info?.packageName && info.packageName !== packageName ? (
                        <span className="font-mono text-warning">· {info.packageName}</span>
                      ) : info?.packageName ? (
                        <span className="font-mono text-muted-foreground">
                          · {info.packageName}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      Could not read a version out of this file — the hub will try again on upload.
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          )}

          {uploading ? <Progress value={uploadPct ?? 0} /> : null}

          {uploadError ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {uploadError}
            </p>
          ) : null}

          {selected ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-sm">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
              <span className="font-mono">{selected.packageName}</span>
              <Badge variant="success">{selected.version}</Badge>
              <span className="text-xs text-muted-foreground">
                {formatBytes(selected.sizeBytes)}
                {selected.sha256 ? ` · sha256 ${selected.sha256.slice(0, 12)}…` : ""}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => setSelected(null)}
              >
                Choose another
              </Button>
            </div>
          ) : null}

          {source !== "feed" && buildsForPackage.length > 0 ? (
            <div className="flex flex-col gap-2 border-t border-border pt-4">
              <p className="text-xs font-medium text-muted-foreground">
                Already uploaded{packageName ? ` for ${packageName}` : ""}
              </p>
              <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {buildsForPackage.map((build) => (
                  <li
                    key={build.id}
                    className={cn(
                      "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                      selected?.id === build.id
                        ? "border-primary/40 bg-primary/5"
                        : "border-border",
                    )}
                  >
                    <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="font-mono">{build.version}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {build.packageName} · {formatBytes(build.sizeBytes)} ·{" "}
                      <RelativeTime value={build.uploadedAt} />
                    </span>
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canOperate || pending}
                        onClick={() => setSelected(build)}
                      >
                        Use this
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label={`Forget ${build.version}`}
                        disabled={!canOperate || pending}
                        onClick={() => remove(build)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* --- 3. where ------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle>3 · Which boxes</CardTitle>
          <CardDescription>
            Offline boxes can be picked: the job waits queued and dispatches the moment the agent
            reconnects.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput value={query} onChange={setQuery} placeholder="Search name, serial…" />
            <Select
              aria-label="Filter by group"
              placeholder="Select group…"
              value={groupFilter}
              onValueChange={setGroupFilter}
              className="w-44"
              options={[
                { value: "", label: "All groups" },
                ...groups.map((g) => ({ value: g.id, label: g.name })),
              ]}
            />
            {/* A checkbox rather than a button: the label stays put whether
                the set is picked or not, so the row does not reflow on every
                click the way a Select/Clear button did. */}
            <label className="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm">
              <Checkbox
                checked={allVisiblePicked ? true : someVisiblePicked ? "indeterminate" : false}
                onCheckedChange={toggleAllVisible}
                aria-label="Select every device in this filter"
                disabled={!canOperate || visibleDevices.length === 0}
              />
              <span className="tabular-nums">Select all {visibleDevices.length}</span>
            </label>
            {/* Fixed width and tabular figures: the search input beside it is
                flex-1, so a counter that grows from "0 picked" to "12 picked"
                would steal width from it and shuffle the whole row on every
                click. */}
            <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {picked.size} picked
            </span>
          </div>

          <div className="rounded-lg border border-border">
            <Table containerClassName="max-h-80">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableSortHead {...headProps("device")}>Device</TableSortHead>
                  <TableSortHead {...headProps("group")}>Group</TableSortHead>
                  <TableSortHead {...headProps("version")}>
                    {packageName ? packageName.split(".").pop() : "Installed"}
                  </TableSortHead>
                  {extraColumns.map((column) => (
                    <TableSortHead
                      key={column.packageName}
                      {...headProps(`pkg:${column.packageName}`)}
                    >
                      {column.label}
                    </TableSortHead>
                  ))}
                  <TableSortHead {...headProps("free")} align="right">
                    Free
                  </TableSortHead>
                  <TableSortHead {...headProps("lastSeen")}>Last seen</TableSortHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleDevices.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6 + extraColumns.length}
                      className="py-8 text-center text-muted-foreground"
                    >
                      No approved device matches this filter.
                    </TableCell>
                  </TableRow>
                ) : null}
                {visibleDevices.map((device) => {
                  const current = packageName ? device.installed[packageName] : undefined;
                  return (
                    <TableRow
                      key={device.id}
                      // The whole row is the hit target: picking twenty boxes
                      // should not mean twenty small checkboxes.
                      className="cursor-pointer"
                      onClick={() => {
                        if (canOperate) toggleDevice(device.id);
                      }}
                    >
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={picked.has(device.id)}
                          onCheckedChange={() => toggleDevice(device.id)}
                          aria-label={`Select ${device.name}`}
                          disabled={!canOperate}
                        />
                      </TableCell>

                      <TableCell>
                        <div className="flex items-center gap-2">
                          <OnlineDot online={device.online} />
                          <div className="min-w-0">
                            <p className="truncate font-medium">{device.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {device.model ?? device.serial}
                              {device.androidVersion ? ` · Android ${device.androidVersion}` : ""}
                            </p>
                          </div>
                        </div>
                      </TableCell>

                      <TableCell className="text-muted-foreground">
                        {device.groupName ?? "—"}
                      </TableCell>

                      <TableCell className="font-mono text-xs">
                        {current ?? (
                          <span className="font-sans text-muted-foreground">not installed</span>
                        )}
                      </TableCell>

                      {extraColumns.map((column) => (
                        <TableCell key={column.packageName} className="font-mono text-xs">
                          {device.installed[column.packageName] ?? (
                            <span className="font-sans text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      ))}

                      <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                        {device.freeBytes === null ? "—" : formatBytes(device.freeBytes)}
                      </TableCell>

                      <TableCell className="text-xs text-muted-foreground">
                        <RelativeTime value={device.lastSeenAt} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* --- 4. how -------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>4 · Hooks and options</CardTitle>
          <CardDescription>
            Shell run as root on the box, around the install. Left empty, each box falls back to its
            group&apos;s own hook, which stops and starts the watched app, not this one.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Which hooks run</Label>
            <div
              role="radiogroup"
              aria-label="Which hooks run"
              className="grid grid-cols-1 gap-2 sm:grid-cols-3"
            >
              {HOOK_MODES.map((option) => {
                const active = effectiveHookMode === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={!canOperate}
                    onClick={() => {
                      setHookMode(option.id);
                      setHookModeTouched(true);
                    }}
                    className={cn(
                      "flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
                      "disabled:cursor-not-allowed disabled:opacity-60",
                      active ? "border-primary bg-primary/10" : "border-border hover:bg-subtle",
                    )}
                  >
                    <span className="text-sm font-medium">{option.label}</span>
                    <span className="text-xs text-muted-foreground">{option.hint}</span>
                  </button>
                );
              })}
            </div>
            {/* Why it landed where it did. Without this the pre-selection reads
                as the form having an opinion nobody can check. */}
            <p className="text-xs text-muted-foreground">
              {hookModeTouched
                ? "Picked by hand."
                : picked.size === 0
                  ? "Pick the boxes and this follows what they already have."
                  : suggestedHookMode === "NORMAL"
                    ? "Some of the picked boxes already run their group's scanner, so there is something to stop and start."
                    : suggestedHookMode === "POST_ONLY"
                      ? "None of the picked boxes run their group's scanner yet, and this deploy is what puts it there."
                      : "None of the picked boxes run their group's scanner, and this deploy is not what installs it."}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pre">Pre-install hook</Label>
              <Textarea
                id="pre"
                value={preHook}
                onChange={(e) => setPreHook(e.target.value)}
                placeholder={
                  packageName ? `am force-stop ${packageName}` : "am force-stop com.example.app"
                }
                disabled={!canOperate || effectiveHookMode !== "NORMAL"}
              />
              {effectiveHookMode !== "NORMAL" ? (
                <p className="text-xs text-muted-foreground">Not run under the choice above.</p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="post">Post-install hook</Label>
              <Textarea
                id="post"
                value={postHook}
                onChange={(e) => setPostHook(e.target.value)}
                placeholder={
                  packageName
                    ? `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`
                    : "monkey -p com.example.app -c android.intent.category.LAUNCHER 1"
                }
                disabled={!canOperate || effectiveHookMode === "NONE"}
              />
              {effectiveHookMode === "NONE" ? (
                <p className="text-xs text-muted-foreground">Not run under the choice above.</p>
              ) : null}
            </div>
          </div>

          {groups.some((g) => g.preInstallHook || g.postInstallHook) ? (
            <details className="rounded-lg border border-border bg-subtle px-3 py-2 text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                What the groups run today
              </summary>
              <ul className="mt-2 flex flex-col gap-2">
                {groups
                  .filter((g) => g.preInstallHook || g.postInstallHook)
                  .map((g) => (
                    <li key={g.id}>
                      <p className="font-medium">{g.name}</p>
                      {g.preInstallHook ? (
                        <p className="font-mono text-muted-foreground">pre: {g.preInstallHook}</p>
                      ) : null}
                      {g.postInstallHook ? (
                        <p className="font-mono text-muted-foreground">post: {g.postInstallHook}</p>
                      ) : null}
                    </li>
                  ))}
              </ul>
            </details>
          ) : null}

          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="text-sm font-medium">Clean install</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Uninstall first instead of upgrading in place.
                </span>
              </span>
              <Switch checked={forceClean} onCheckedChange={setForceClean} disabled={!canOperate} />
            </label>

            {/* Off by default, which is the opposite of the fleet's deploy
                form and deliberate: there, a rollout is a version moving
                forward and a box already on it has nothing to do. Here the
                same version going out twice usually means the first build was
                wrong, and the version string cannot tell the two apart. */}
            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="text-sm font-medium">Skip boxes already on this version</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {selected && split.same > 0
                    ? `${split.same} of the ${split.total} picked report ${selected.version}. They would be marked skipped instead of installed.`
                    : "Leave off to reinstall everywhere, a rebuilt APK under the same version is still a different build."}
                </span>
              </span>
              <Switch
                checked={skipUpToDate}
                onCheckedChange={setSkipUpToDate}
                disabled={!canOperate}
              />
            </label>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="note">Note</Label>
            <Input
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why this build is going out"
              disabled={!canOperate}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <p className="text-sm text-muted-foreground">
          {selected ? (
            <>
              <span className="font-mono text-foreground">{selected.packageName}</span>{" "}
              <Badge variant="outline">{selected.version}</Badge> on{" "}
              <span className="text-foreground">{split.total}</span> box
              {split.total === 1 ? "" : "es"}
              {/* Which of them have it already is the question the page used to
                  leave unanswered, and it is the difference between a first
                  install and an upgrade that can wipe data. */}
              {split.total > 0 && split.fresh > 0 && split.updates > 0
                ? ` · ${split.fresh} first install${split.fresh === 1 ? "" : "s"}, ${split.updates} update${split.updates === 1 ? "" : "s"}`
                : split.total > 0 && split.fresh > 0
                  ? ` · all first installs`
                  : split.total > 0
                    ? ` · all updates`
                    : ""}
              {forceClean ? " · data will be wiped" : ""}
              {skipUpToDate && split.same > 0 ? ` · ${split.same} skipped` : ""}
            </>
          ) : (
            "Upload a build or pick one above."
          )}
        </p>
        <Button
          onClick={install}
          disabled={!canOperate || pending || !selected || picked.size === 0}
        >
          <Wand2 />
          {pending
            ? "Starting…"
            : split.total > 0 && split.updates === 0
              ? `Install on ${split.total}`
              : "Install now"}
        </Button>
      </div>

      {/* Asked only when a config is written: an install alone is recoverable
          by installing something else, and a rewritten config is not. */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) setConfirmError(null);
        }}
        title="Write the group config too?"
        description={
          <>
            This deploy installs <span className="font-mono text-xs">{selected?.packageName}</span>{" "}
            on <span className="text-foreground">{split.total}</span> box
            {split.total === 1 ? "" : "es"} and overwrites the config on{" "}
            <span className="text-foreground">{configWriteCount}</span> of them with{" "}
            {configOverride !== null
              ? "the one written on this page"
              : configuredGroups.length === 1
                ? "the group's current one"
                : "their group's current one"}
            .
          </>
        }
        confirmLabel="Install and write"
        pendingLabel="Starting…"
        pending={pending}
        error={confirmError}
        onConfirm={confirmInstall}
      >
        <div className="flex flex-col gap-2 rounded-md border border-border bg-subtle px-3 py-2 text-xs text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">
              {configuredGroups.map((g) => g.name).join(", ")}
            </span>{" "}
            {configuredGroups.length === 1 ? "has" : "have"} this app as their MITM. Whatever is on
            those boxes now, including anything edited on the box by hand, is replaced, and there is
            no copy of it anywhere else.{" "}
            {configOverride !== null
              ? "This deploy carries its own config, so the group's is not what lands — and the group's is left exactly as it is."
              : ""}
          </p>
          {forceClean ? (
            <p className="text-destructive">
              Force clean is on as well, so the app&apos;s data is wiped before it is installed.
            </p>
          ) : null}
          <p>If you don't want to overwrite, toggle it off at the top of the page.</p>
        </div>
      </ConfirmDialog>
    </div>
  );
}
