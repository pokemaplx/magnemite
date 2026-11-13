"use client";

import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "@bprogress/next/app";
import { useFormStatus } from "react-dom";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronDown,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Power,
  Radio,
  Rocket,
  ScrollText,
  ShieldCheck,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { JobState, VersionSource } from "@magnemite/db";
import type { ExecMitm, MitmColumn } from "@/lib/mitm-columns";
import { startRollout, type ActionState } from "@/actions/rollouts";
import { setDeviceApproval } from "@/actions/devices";
import { DeviceActionDialogs, useLogcat, type DeviceTarget } from "@/components/device-actions";
import { ChangeGroupDialog } from "@/components/change-group-dialog";
import { AddBoxDialog } from "@/components/add-box-dialog";
import { EnrollingBanner, type EnrollingRow } from "@/components/enrolling-boxes";
import { useHotkey } from "@/components/shortcuts/hotkeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { SELECT_FIELD, Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSortHead,
} from "@/components/ui/table";
import { TablePaginationBar } from "@/components/ui/table-pagination";
import { useToast } from "@/components/ui/toast";
import { ACTIVE_JOB_STATES, JobStateBadge, OnlineDot } from "@/components/status";
import { commandBlocker, type DeviceAction, type DeviceCommand } from "@/lib/device-commands";
import { formatBytes } from "@/lib/format";
import { primaryKey } from "@/lib/shortcuts";
import { RelativeTime } from "@/components/relative-time";
import { useTablePagination } from "@/lib/table-pagination";
import { useTableSort } from "@/lib/table-sort";
import {
  SCANNER_LABEL,
  SCANNER_RANK,
  SCANNER_TITLE,
  SCANNER_VARIANT,
  scannerState,
  workerLabel,
} from "@/lib/rotom";
import { cn } from "@/lib/utils";

export type DeviceRow = {
  id: string;
  name: string;
  serial: string;
  online: boolean;
  approved: boolean;
  /**
   * ISO string while somebody is working on this box, null otherwise.
   *
   * It earns a column's worth of space in the status cell because it changes
   * what the rest of this table will do to the box: selecting it and pressing
   * Update is refused while it is set.
   */
  maintenanceUntil: string | null;
  /**
   * ISO string while we still hold this box's socket and its heartbeats have
   * stopped anyway, null otherwise.
   *
   * The third state the two-value status cannot say. `online` stays true
   * because the socket is genuinely there — and that is the useful half: a
   * restart or a reboot can still be sent to this box, which is not true of
   * one that is simply gone.
   */
  beatStaleSince: string | null;
  model: string | null;
  androidVersion: string | null;
  agentVersion: string | null;
  groupId: string | null;
  groupName: string | null;
  /** The machine a Redroid container runs on, by its Device id. Null on hardware. */
  hostId: string | null;
  /** Whether its agent knows `collect_screenshot`. */
  canScreenshot: boolean;
  installedVersion: string | null;
  /** Installed version of each group's MITM, keyed by package name. */
  mitmVersions: Record<string, string | null>;
  freeBytes: number | null;
  lastSeenAt: string | null;
  /**
   * Only present when the Rotom integration is on and this box was matched.
   *
   * `workersInUse` and `requestRate` are null when Rotom did not say, which is
   * not the same as zero: it only measures request rates in some modes, and a
   * badge that showed 0/s on a Rotom that does not count would be a lie.
   */
  rotom: {
    connected: boolean;
    workers: number | null;
    workersInUse: number | null;
    enabled: boolean;
    requestRate: number | null;
  } | null;
  job: {
    id: string;
    rolloutId: string;
    state: JobState;
    progress: number;
    toVersion: string;
  } | null;
};

export type VersionOption = {
  id: string;
  /** The app this build belongs to. A rollout ships exactly one of them. */
  targetId: string;
  targetName: string;
  targetPackage: string;
  version: string;
  source: VersionSource;
  sizeBytes: number;
  approved: boolean;
};

type Filter = "all" | "online" | "offline" | "outdated" | "pending";

/**
 * The key hardware boxes go under in the "where it runs" filter. Every other
 * key is a machine's Device id, which is a cuid and never this.
 */
const HARDWARE = ":boxes";

function scannerCell(rotom: DeviceRow["rotom"]) {
  const state = scannerState(rotom);
  if (!rotom || state === "unmatched") {
    return (
      <span className="text-xs text-muted-foreground" title={SCANNER_TITLE.unmatched}>
        —
      </span>
    );
  }

  return (
    <Badge variant={SCANNER_VARIANT[state]} title={SCANNER_TITLE[state]}>
      {SCANNER_LABEL[state]}
      {/* The counts only mean something once Rotom has the box. */}
      {state === "notConnected" || state === "disabled" ? "" : workerLabel(rotom)}
      {/* Omitted rather than zeroed when Rotom does not measure rates. */}
      {state === "scanning" && rotom.requestRate !== null ? ` · ${rotom.requestRate}/s` : ""}
    </Badge>
  );
}

// Plus one `pkg:<name>` per MITM column, which is why this is not a closed
// union.
type FleetSortKey = string;

export function FleetTable({
  rows,
  groups,
  versions,
  latestVersion,
  packageName,
  mitmColumns,
  canOperate,
  machines,
  hosts,
  enrolling,
}: {
  rows: DeviceRow[];
  /**
   * `mitm` is the group's, for the Execute dialog's config buttons — on the
   * group rather than on every row, which would resend it with each refresh.
   * Null for a viewer, who never gets to open that dialog.
   */
  groups: { id: string; name: string; mitm: ExecMitm | null }[];
  versions: VersionOption[];
  latestVersion: string | null;
  packageName: string;
  mitmColumns: MitmColumn[];
  canOperate: boolean;
  /** Online machines, the only things that can relay an adb enrollment. */
  machines: { id: string; name: string }[];
  /** Every machine, online or not, for the "where it runs" filter. */
  hosts: { id: string; name: string }[];
  /** Hardware boxes partway through being added over adb. */
  enrolling: EnrollingRow[];
}) {
  // The scanner column only earns its space once Rotom has matched something.
  const showRotom = rows.some((row) => row.rotom !== null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [group, setGroup] = useState("");
  // What the "where it runs" filter hides, rather than what it shows, so a
  // machine added while the page is open shows up instead of being filtered
  // out by a list that predates it. Empty shows everything.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const accessors = useMemo(() => {
    const map: Record<FleetSortKey, (row: DeviceRow) => string | number | null> = {
      device: (r) => r.name,
      group: (r) => r.groupName,
      version: (r) => r.installedVersion,
      scanner: (r) => SCANNER_RANK[scannerState(r.rotom)],
      // Offline boxes sort together, and a box mid-update outranks an idle one.
      status: (r) => (r.job ? 3 : r.online ? 2 : 1),
      free: (r) => r.freeBytes,
      agent: (r) => r.agentVersion,
      lastSeen: (r) => r.lastSeenAt,
    };
    for (const column of mitmColumns) {
      map[`pkg:${column.packageName}`] = (r) => r.mitmVersions[column.packageName] ?? null;
    }
    return map;
  }, [mitmColumns]);

  const { headProps, sort, sortRows } = useTableSort<FleetSortKey, DeviceRow>(accessors, {
    key: "device",
    direction: "asc",
  });

  const stats = useMemo(() => {
    const online = rows.filter((r) => r.online).length;
    const upToDate = latestVersion
      ? rows.filter((r) => r.installedVersion === latestVersion).length
      : 0;
    const pending = rows.filter((r) => !r.approved).length;
    const working = rows.filter((r) => r.job && ACTIVE_JOB_STATES.includes(r.job.state)).length;
    return { online, upToDate, pending, working };
  }, [rows, latestVersion]);

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (group && row.groupName !== group) return false;
      if (hidden.has(row.hostId ?? HARDWARE)) return false;
      if (filter === "online" && !row.online) return false;
      if (filter === "offline" && row.online) return false;
      if (filter === "pending" && row.approved) return false;
      if (filter === "outdated") {
        if (!latestVersion || row.installedVersion === latestVersion) return false;
      }
      if (!q) return true;
      return (
        row.name.toLowerCase().includes(q) ||
        row.serial.toLowerCase().includes(q) ||
        (row.model?.toLowerCase().includes(q) ?? false) ||
        (row.installedVersion?.toLowerCase().includes(q) ?? false) ||
        Object.values(row.mitmVersions).some(
          (version) => version?.toLowerCase().includes(q) ?? false,
        )
      );
    });
    return sortRows(filtered);
  }, [rows, query, filter, group, hidden, latestVersion, sortRows]);

  const resetKey = `${query}|${filter}|${group}|${[...hidden].sort().join(",")}|${sort.key}|${sort.direction}`;
  const pagination = useTablePagination(matching, { resetKey });
  const visible = pagination.rows;

  // Selection follows the page you are looking at: the header checkbox ticks
  // what is in front of you, and anything already picked on another page stays
  // picked — the button label keeps the running count honest.
  const selectableIds = visible.filter((r) => r.approved).map((r) => r.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const someSelected = selectableIds.some((id) => selected.has(id));

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) selectableIds.forEach((id) => next.delete(id));
      else selectableIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // The picked boxes in the order they are on screen, not `[...selected]` —
  // a Set iterates in insertion order, which is the order the checkboxes were
  // ticked. That is invisible for a rollout and wrong for a rename, where the
  // counter follows this list and would otherwise number the fleet seemingly at
  // random. `matching` rather than `visible` because selection spans pages.
  const selectedRows = matching.filter((r) => selected.has(r.id));
  const selectedInOrder = selectedRows.map((r) => r.id);

  const router = useRouter();
  const toast = useToast();
  const logcat = useLogcat();

  // The row the keys act on. An id rather than an index, so a refresh that
  // reorders the table moves the cursor along with its box instead of onto
  // whichever box took its place.
  const [cursorId, setCursorId] = useState<string | null>(null);
  // Only ever a row on screen: a refresh can sort the cursor's box onto
  // another page or filter it out, and a key must not act on a row nobody can
  // see.
  const cursorRow = visible.find((row) => row.id === cursorId) ?? null;
  const scrollToCursor = useRef(false);

  // A new filter or sort is a new list; the cursor starts again with it.
  useEffect(() => setCursorId(null), [resetKey]);

  useEffect(() => {
    if (!scrollToCursor.current || !cursorId) return;
    scrollToCursor.current = false;
    document
      .querySelector(`[data-row-id="${CSS.escape(cursorId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursorId, pagination.page]);

  // What the dialogs below are open for. The ids outlive the dialog closing so
  // reopening on the same box finds it as it was left, as on the device page.
  const [action, setAction] = useState<{ action: DeviceAction | null; ids: string[] }>({
    action: null,
    ids: [],
  });
  const [rolloutOpen, setRolloutOpen] = useState(false);

  // The bar the Update dialog hangs off goes when the selection does.
  useEffect(() => {
    if (selected.size === 0) setRolloutOpen(false);
  }, [selected.size]);

  const rowsById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const mitmByGroup = useMemo(() => new Map(groups.map((g) => [g.id, g.mitm])), [groups]);
  const targets: DeviceTarget[] = action.ids
    .map((id) => rowsById.get(id))
    .filter((row): row is DeviceRow => row !== undefined)
    .map((row) => ({
      id: row.id,
      name: row.name,
      online: row.online,
      canScreenshot: row.canScreenshot,
      maintenanceUntil: row.maintenanceUntil,
      mitm: row.groupId ? (mitmByGroup.get(row.groupId) ?? null) : null,
    }));

  /** One box's action, from its row's menu or from a key on the cursor's row. */
  function act(command: DeviceCommand, row: DeviceRow) {
    const blocker = commandBlocker(row, command);
    if (blocker) {
      toast(blocker);
      return;
    }
    if (command === "logcat") logcat.download(row.id);
    else setAction({ action: command, ids: [row.id] });
  }

  function onCursorRow(command: DeviceCommand) {
    if (cursorRow) act(command, cursorRow);
    else toast("Move to a device first — j and k move the cursor.");
  }

  /** Rename and Reboot take the selection when there is one. */
  function onPicked(command: "rename" | "reboot") {
    if (selectedRows.length === 1) act(command, selectedRows[0]!);
    else if (selectedRows.length > 1) setAction({ action: command, ids: selectedInOrder });
    else onCursorRow(command);
  }

  const perPage =
    pagination.pageSize === "all" ? Math.max(matching.length, 1) : pagination.pageSize;

  /**
   * j and k walk the whole filtered list, turning the page at either end of
   * this one. The arrows only once a row has the cursor: until then they are
   * the page's own, and scroll it.
   */
  function move(delta: 1 | -1, event: KeyboardEvent | null): boolean {
    if (event?.key.startsWith("Arrow") && !cursorRow) return false;
    if (matching.length === 0) return false;
    const at = cursorRow ? matching.indexOf(cursorRow) : -1;
    const next =
      at === -1
        ? delta === 1
          ? pagination.from - 1
          : pagination.to - 1
        : Math.min(Math.max(at + delta, 0), matching.length - 1);
    const row = matching[next];
    if (!row) return false;
    const page = Math.floor(next / perPage) + 1;
    if (page !== pagination.page) pagination.setPage(page);
    scrollToCursor.current = true;
    setCursorId(row.id);
    return true;
  }

  useHotkey("fleet.down", (event) => move(1, event));
  useHotkey("fleet.up", (event) => move(-1, event));
  useHotkey("fleet.open", () => {
    if (!cursorRow) return false;
    router.push(`/devices/${cursorRow.id}`);
  });
  useHotkey(
    "fleet.select",
    () => {
      if (!cursorRow) return false;
      if (!cursorRow.approved) {
        toast(`${cursorRow.name} is waiting for approval, so it cannot be picked yet.`);
        return;
      }
      toggleOne(cursorRow.id);
    },
    { enabled: canOperate },
  );
  useHotkey(
    "fleet.selectPage",
    () => {
      if (selectableIds.length === 0) return false;
      toggleAll();
    },
    { enabled: canOperate },
  );
  useHotkey(
    "fleet.update",
    () => {
      if (selected.size === 0) {
        toast("Pick the devices to update first — x picks the one under the cursor.");
        return;
      }
      setRolloutOpen(true);
    },
    { enabled: canOperate },
  );
  // The cursor first, then the selection: one Escape too many should not throw
  // away forty ticked boxes.
  useHotkey("fleet.clear", () => {
    if (cursorRow) setCursorId(null);
    else if (selected.size > 0) setSelected(new Set());
    else return false;
  });
  useHotkey("device.exec", () => onCursorRow("exec"), { enabled: canOperate });
  useHotkey("device.logs", () => onCursorRow("logs"), { enabled: canOperate });
  useHotkey("device.screenshot", () => onCursorRow("screenshot"), { enabled: canOperate });
  useHotkey("device.logcat", () => onCursorRow("logcat"), { enabled: canOperate });
  useHotkey("device.maintenance", () => onCursorRow("maintenance"), { enabled: canOperate });
  useHotkey("device.rename", () => onPicked("rename"), { enabled: canOperate });
  useHotkey("device.reboot", () => onPicked("reboot"), { enabled: canOperate });

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Fleet</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length} device{rows.length === 1 ? "" : "s"} · {stats.online} online ·{" "}
            {stats.upToDate} on {latestVersion ?? "—"}
            {stats.working > 0 ? ` · ${stats.working} updating` : ""}
          </p>
        </div>

        {/* Only "Update all" stays up here — it is the one action that does not
            depend on a selection. Everything that acts on picked boxes lives in
            the bar that appears at the bottom once there are any. */}
        {canOperate ? (
          <div className="flex items-center gap-2">
            {/* A hardware box is a box, so it is added from the fleet rather
                than from a page of its own. */}
            <AddBoxDialog groups={groups} machines={machines} />
            <RolloutDialog
              versions={versions}
              deviceIds={[]}
              label="Update all"
              disabled={rows.length === 0}
              variant="outline"
            />
          </div>
        ) : null}
      </header>

      {enrolling.length > 0 ? <EnrollingBanner rows={enrolling} canOperate={canOperate} /> : null}

      {stats.pending > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm">
          <AlertTriangle className="h-4 w-4 text-warning" />
          {stats.pending} device{stats.pending === 1 ? "" : "s"} waiting for approval — they will
          not receive updates until approved.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search name, serial, model, version…"
          shortcut
        />

        <Select
          aria-label="Filter devices"
          value={filter}
          onValueChange={(value) => setFilter(value as Filter)}
          className="w-40"
          options={[
            { value: "all", label: "All devices" },
            { value: "online", label: "Online" },
            { value: "offline", label: "Offline" },
            { value: "outdated", label: "Outdated" },
            { value: "pending", label: "Pending approval" },
          ]}
        />

        <Select
          aria-label="Filter by group"
          placeholder="Select group…"
          value={group}
          onValueChange={setGroup}
          className="w-40"
          options={[
            { value: "", label: "All groups" },
            ...groups.map((g) => ({ value: g.name, label: g.name })),
          ]}
        />

        {/* Only once there is a machine: before that every box is hardware,
            and a filter with one answer is clutter. */}
        {hosts.length > 0 ? (
          <WhereFilter hosts={hosts} hidden={hidden} onHiddenChange={setHidden} />
        ) : null}
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <Table containerClassName="lg:max-h-[64vh]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={toggleAll}
                  aria-label="Select all on this page"
                  disabled={!canOperate || selectableIds.length === 0}
                />
              </TableHead>
              <TableSortHead {...headProps("device")}>Device</TableSortHead>
              <TableSortHead {...headProps("group")}>Group</TableSortHead>
              <TableSortHead {...headProps("version")}>
                {packageName.split(".").pop()}
              </TableSortHead>
              {mitmColumns.map((column) => (
                <TableSortHead key={column.packageName} {...headProps(`pkg:${column.packageName}`)}>
                  {column.label}
                </TableSortHead>
              ))}
              {showRotom ? <TableSortHead {...headProps("scanner")}>Scanner</TableSortHead> : null}
              <TableSortHead {...headProps("status")}>Status</TableSortHead>
              <TableSortHead {...headProps("free")} align="right">
                Free
              </TableSortHead>
              <TableSortHead {...headProps("agent")}>Agent</TableSortHead>
              <TableSortHead {...headProps("lastSeen")}>Last seen</TableSortHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={(showRotom ? 10 : 9) + mitmColumns.length}
                  className="py-10 text-center text-muted-foreground"
                >
                  {rows.length === 0
                    ? "No devices yet. Flash the Magisk module on a box and it will show up here."
                    : "No devices match this filter."}
                </TableCell>
              </TableRow>
            ) : (
              visible.map((row) => (
                <DeviceRowView
                  key={row.id}
                  row={row}
                  latestVersion={latestVersion}
                  selected={selected.has(row.id)}
                  cursor={row.id === cursorRow?.id}
                  onToggle={() => toggleOne(row.id)}
                  onPoint={() => setCursorId(row.id)}
                  onAction={(command) => {
                    setCursorId(row.id);
                    act(command, row);
                  }}
                  canOperate={canOperate}
                  showRotom={showRotom}
                  mitmColumns={mitmColumns}
                />
              ))
            )}
          </TableBody>
        </Table>
        <TablePaginationBar pagination={pagination} unit="devices" />
      </div>

      {/* What to do with the boxes you picked, where your eyes already are —
          on the rows, not back up at the header. It appears only when there is
          a selection, so the actions never sit there greyed out explaining
          nothing.

          The wrapper spans the viewport to centre the bar and is
          pointer-events-none, or an invisible full-width strip would eat clicks
          on whatever is behind it. z-40 keeps it under the dialogs it opens. */}
      {canOperate && selected.size > 0 ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
          <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 shadow-lg">
            <span className="px-1 text-sm tabular-nums">{selected.size} selected</span>
            <RolloutDialog
              versions={versions}
              deviceIds={selectedInOrder}
              label="Update"
              disabled={false}
              variant="default"
              open={rolloutOpen}
              onOpenChange={setRolloutOpen}
            />
            <Button variant="outline" onClick={() => onPicked("rename")}>
              <Pencil />
              Rename
            </Button>
            <ChangeGroupDialog
              devices={selectedRows.map((row) => ({ id: row.id, groupName: row.groupName }))}
              groups={groups}
              trigger={
                <Button variant="outline">
                  <FolderInput />
                  Change group
                </Button>
              }
            />
            <Button variant="outline" onClick={() => onPicked("reboot")}>
              <Power />
              Reboot
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Clear the selection"
              onClick={() => setSelected(new Set())}
            >
              <X />
            </Button>
          </div>
        </div>
      ) : null}

      <DeviceActionDialogs
        action={action.action}
        targets={targets}
        onClose={() => setAction((current) => ({ ...current, action: null }))}
      />
    </div>
  );
}

function DeviceRowView({
  row,
  latestVersion,
  selected,
  cursor,
  onToggle,
  onPoint,
  onAction,
  canOperate,
  showRotom,
  mitmColumns,
}: {
  row: DeviceRow;
  latestVersion: string | null;
  selected: boolean;
  /** The row the keys act on. */
  cursor: boolean;
  onToggle: () => void;
  /** A click on the row itself, which puts the cursor there. */
  onPoint: () => void;
  onAction: (command: DeviceCommand) => void;
  canOperate: boolean;
  mitmColumns: MitmColumn[];
  showRotom: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const upToDate = latestVersion !== null && row.installedVersion === latestVersion;
  // Under ~450 MB a box cannot hold the bundle and its unpacked splits.
  const lowSpace = row.freeBytes !== null && row.freeBytes < 500 * 1024 * 1024;
  const parked =
    row.maintenanceUntil !== null && new Date(row.maintenanceUntil).getTime() > Date.now();

  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      data-row-id={row.id}
      data-cursor={cursor || undefined}
      // A bar down the left edge rather than a fill: selected rows are already
      // filled, and the cursor has to read on top of them. On the first cell,
      // because a row's own box-shadow is not painted under border-collapse.
      // The scroll margin keeps a row scrolled to from tucking under the
      // sticky header.
      className="scroll-mt-10 data-[cursor=true]:bg-subtle [&[data-cursor=true]>td:first-child]:shadow-[inset_2px_0_0_var(--color-primary)]"
      onClick={(event) => {
        if (!(event.target instanceof Element)) return;
        if (event.target.closest('a,button,input,label,[role="checkbox"],[role="menuitem"]'))
          return;
        onPoint();
      }}
    >
      <TableCell>
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          disabled={!canOperate || !row.approved}
          aria-label={`Select ${row.name}`}
        />
      </TableCell>

      <TableCell>
        <div className="flex items-center gap-2">
          <OnlineDot online={row.online} />
          <div className="min-w-0">
            <Link
              href={`/devices/${row.id}`}
              className="block truncate font-medium hover:underline"
            >
              {row.name}
            </Link>
            <div className="truncate text-xs text-muted-foreground">
              {row.model ?? row.serial}
              {row.androidVersion ? ` · Android ${row.androidVersion}` : ""}
            </div>
          </div>
        </div>
      </TableCell>

      <TableCell className="text-muted-foreground">{row.groupName ?? "—"}</TableCell>

      <TableCell>
        {row.installedVersion ? (
          <Badge variant={upToDate ? "success" : "warning"}>
            {upToDate ? <CheckCircle2 className="h-3 w-3" /> : null}
            {row.installedVersion}
          </Badge>
        ) : (
          <span className="text-muted-foreground">not installed</span>
        )}
      </TableCell>

      {mitmColumns.map((column) => {
        const version = row.mitmVersions[column.packageName] ?? null;
        return (
          <TableCell key={column.packageName} className="font-mono text-xs">
            {version ?? <span className="font-sans text-muted-foreground">—</span>}
          </TableCell>
        );
      })}

      {showRotom ? <TableCell>{scannerCell(row.rotom)}</TableCell> : null}

      <TableCell className="min-w-44">
        {!row.approved ? (
          <Badge variant="warning">pending approval</Badge>
        ) : row.beatStaleSince ? (
          // Ahead of maintenance and the job both: a box that has stopped
          // reporting is not running that job either, and the dot beside the
          // name says "online" because the socket really is there. Without
          // this the row reads as perfectly healthy.
          <Badge
            variant="warning"
            title={`Connected, but nothing since ${new Date(row.beatStaleSince).toLocaleString()}`}
          >
            not reporting
          </Badge>
        ) : row.maintenanceUntil && new Date(row.maintenanceUntil).getTime() > Date.now() ? (
          // Ahead of the job, deliberately: a box with a job still queued on
          // it and a window open is not going to run that job, and showing the
          // job would say the opposite.
          <Badge variant="info" title={`Until ${new Date(row.maintenanceUntil).toLocaleString()}`}>
            in maintenance
          </Badge>
        ) : row.job ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <JobStateBadge state={row.job.state} />
              <Link
                href={`/rollouts/${row.job.rolloutId}`}
                className="text-xs text-muted-foreground hover:underline"
              >
                → {row.job.toVersion}
              </Link>
            </div>
            {ACTIVE_JOB_STATES.includes(row.job.state) ? (
              <Progress value={row.job.progress} />
            ) : null}
          </div>
        ) : (
          <span className="text-muted-foreground">idle</span>
        )}
      </TableCell>

      <TableCell
        className={cn("text-right font-mono text-xs", lowSpace && "text-warning")}
        title={lowSpace ? "Too little space for a 170 MB bundle plus its splits" : undefined}
      >
        {formatBytes(row.freeBytes)}
      </TableCell>

      <TableCell className="font-mono text-xs text-muted-foreground">
        {row.agentVersion ?? "—"}
      </TableCell>

      <TableCell className="text-xs text-muted-foreground">
        {row.online ? "now" : <RelativeTime value={row.lastSeenAt} />}
      </TableCell>

      <TableCell>
        {canOperate ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" disabled={pending}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            {/* The device page's menu, for the row — with the same keys, which
                act on the row under the cursor. */}
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuItem asChild>
                <Link href={`/devices/${row.id}`}>Open device</Link>
              </DropdownMenuItem>
              {!row.approved ? (
                <DropdownMenuItem
                  onSelect={() => startTransition(() => void setDeviceApproval(row.id, true))}
                >
                  <ShieldCheck />
                  Approve
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!row.online} onSelect={() => onAction("exec")}>
                <Terminal />
                Execute
                <DropdownMenuShortcut keys={primaryKey("device.exec")} />
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!row.online} onSelect={() => onAction("logs")}>
                <Radio />
                Live logs
                <DropdownMenuShortcut keys={primaryKey("device.logs")} />
              </DropdownMenuItem>
              {row.canScreenshot ? (
                <DropdownMenuItem disabled={!row.online} onSelect={() => onAction("screenshot")}>
                  <Camera />
                  Screenshot
                  <DropdownMenuShortcut keys={primaryKey("device.screenshot")} />
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem disabled={!row.online} onSelect={() => onAction("logcat")}>
                <ScrollText />
                Logcat (.zip)
                <DropdownMenuShortcut keys={primaryKey("device.logcat")} />
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAction("rename")}>
                <Pencil />
                Rename
                <DropdownMenuShortcut keys={primaryKey("device.rename")} />
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAction("maintenance")}>
                <Wrench />
                {parked ? "End maintenance" : "Maintenance…"}
                <DropdownMenuShortcut keys={primaryKey("device.maintenance")} />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!row.online} onSelect={() => onAction("reboot")}>
                <Power />
                Reboot…
                <DropdownMenuShortcut keys={primaryKey("device.reboot")} />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function RolloutSubmit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      <Rocket />
      {pending ? "Starting…" : "Start rollout"}
    </Button>
  );
}

function RolloutDialog({
  versions,
  deviceIds,
  label,
  disabled,
  variant,
  open: openProp,
  onOpenChange,
}: {
  versions: VersionOption[];
  deviceIds: string[];
  label: string;
  disabled?: boolean;
  variant: "default" | "outline";
  /** Controlled open, for the `u` key; the button works either way. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const [state, formAction] = useActionState<ActionState, FormData>(startRollout, {});
  const [forceClean, setForceClean] = useState(false);
  const [skipUpToDate, setSkipUpToDate] = useState(true);

  // Only apps with something cached can be rolled out at all, so the list is
  // derived from the versions rather than from every configured target — a
  // target with nothing on disk would be a dead end in the picker.
  const apps = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; packageName: string }>();
    for (const version of versions) {
      if (!seen.has(version.targetId)) {
        seen.set(version.targetId, {
          id: version.targetId,
          name: version.targetName,
          packageName: version.targetPackage,
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [versions]);

  const [appTargetId, setAppTargetId] = useState("");
  // Falls back to the first app until one is picked, so the version list is
  // never empty on open.
  const activeAppId = appTargetId || (apps[0]?.id ?? "");
  const appVersions = versions.filter((version) => version.targetId === activeAppId);

  const deviceLabel =
    deviceIds.length > 0 ? `${deviceIds.length} selected device(s)` : "every approved device";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant} disabled={disabled}>
          <Rocket />
          {label}
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start a rollout</DialogTitle>
          <DialogDescription>
            Targets {deviceLabel}. Devices that are offline keep their job queued and pick it up
            when they reconnect.
          </DialogDescription>
        </DialogHeader>

        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No cached versions yet. Go to{" "}
            <Link href="/versions" className="underline">
              Versions
            </Link>{" "}
            and cache one onto the server first.
          </p>
        ) : (
          <form action={formAction} className="flex flex-col gap-4">
            <input type="hidden" name="deviceIds" value={deviceIds.join(",")} />

            <div className="flex flex-col gap-2">
              <Label htmlFor="rolloutAppTarget">App</Label>
              <Select
                id="rolloutAppTarget"
                aria-label="App to roll out"
                placeholder="Select target…"
                value={activeAppId}
                onValueChange={setAppTargetId}
                options={apps.map((app) => ({ value: app.id, label: app.name }))}
              />
              <p className="text-xs text-muted-foreground">
                A rollout ships one app. Only apps with a version cached on this server are listed.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="appVersionId">Version</Label>
              {/* Remounted per app so the default lands on that app's newest
                  build instead of keeping the previous app's selection. */}
              <Select
                key={activeAppId}
                id="appVersionId"
                name="appVersionId"
                placeholder="Select version…"
                required
                defaultValue={appVersions[0]?.id}
                options={appVersions.map((v) => ({
                  value: v.id,
                  label:
                    `${v.version} · ${v.source.toLowerCase()} · ${formatBytes(v.sizeBytes)}` +
                    (v.approved ? "" : " · not approved"),
                }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="canaryCount">Canary devices</Label>
                <Input id="canaryCount" name="canaryCount" type="number" min={0} defaultValue={1} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="soakMinutes">Soak (min)</Label>
                <Input
                  id="soakMinutes"
                  name="soakMinutes"
                  type="number"
                  min={0}
                  defaultValue={15}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="maxAttempts">Attempts</Label>
                <Input id="maxAttempts" name="maxAttempts" type="number" min={1} defaultValue={3} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="retryBackoffSeconds">Retry backoff (s)</Label>
                <Input
                  id="retryBackoffSeconds"
                  name="retryBackoffSeconds"
                  type="number"
                  min={0}
                  defaultValue={60}
                />
              </div>
            </div>
            <p className="-mt-2 text-xs text-muted-foreground">
              The canary devices update first. The rest wait for them to succeed, plus the soak. A
              failed attempt is held for the backoff before the next one, doubling each time — an
              install heavy enough to restart the box needs that long before it can be retried.
            </p>

            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox
                name="forceClean"
                className="mt-0.5"
                checked={forceClean}
                onCheckedChange={(value) => setForceClean(value === true)}
              />
              <span>
                Force a clean install
                <span className="block text-xs text-muted-foreground">
                  Uninstalls first on every device. Normally the agent upgrades in place and only
                  falls back to this when Android rejects the upgrade.
                </span>
              </span>
            </label>

            {forceClean ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <span>
                  WARNING: This wipes the app data on every targeted device: logins and settings
                  included.
                </span>
              </div>
            ) : null}

            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox
                name="skipUpToDate"
                className="mt-0.5"
                checked={skipUpToDate}
                onCheckedChange={(value) => setSkipUpToDate(value === true)}
              />
              <span>
                Skip devices already on this version
                <span className="block text-xs text-muted-foreground">
                  Uncheck to force a reinstall everywhere.
                </span>
              </span>
            </label>

            <div className="flex flex-col gap-2">
              <Label htmlFor="note">Note (optional)</Label>
              <Input id="note" name="note" placeholder="Why this rollout" />
            </div>

            {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <RolloutSubmit />
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Which boxes to show by where they run: hardware, and each machine's
 * containers -- any mix of them, ticked in one menu rather than picked one at a
 * time. "All hosts" ticks or clears every machine at once, and reads as half
 * ticked when only some are.
 */
function WhereFilter({
  hosts,
  hidden,
  onHiddenChange,
}: {
  hosts: { id: string; name: string }[];
  hidden: Set<string>;
  onHiddenChange: (hidden: Set<string>) => void;
}) {
  const hardware = !hidden.has(HARDWARE);
  const shown = hosts.filter((host) => !hidden.has(host.id));
  const allHosts = shown.length === hosts.length;

  function set(keys: string[], show: boolean) {
    const next = new Set(hidden);
    for (const key of keys) {
      if (show) next.delete(key);
      else next.add(key);
    }
    onHiddenChange(next);
  }

  // What is ticked, said as briefly as it can be: a machine by name when it is
  // the only one, a count when it is several.
  const parts: string[] = [];
  if (hardware) parts.push("Boxes");
  if (allHosts) parts.push("All hosts");
  else if (shown.length === 1) parts.push(shown[0]!.name);
  else if (shown.length > 1) parts.push(`${shown.length} hosts`);
  const label =
    hardware && allHosts ? "Boxes and hosts" : parts.length > 0 ? parts.join(" + ") : "Nothing";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Filter by where the box runs"
        className={cn(SELECT_FIELD, "w-48")}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
        <DropdownMenuCheckboxItem
          checked={hardware}
          onCheckedChange={(show) => set([HARDWARE], show)}
        >
          Boxes
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={allHosts ? true : shown.length > 0 ? "indeterminate" : false}
          onCheckedChange={(show) =>
            set(
              hosts.map((host) => host.id),
              show,
            )
          }
        >
          All hosts
        </DropdownMenuCheckboxItem>
        {hosts.map((host) => (
          <DropdownMenuCheckboxItem
            key={host.id}
            className="pl-6"
            checked={!hidden.has(host.id)}
            onCheckedChange={(show) => set([host.id], show)}
          >
            <span className="truncate">{host.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
        {hidden.size > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onHiddenChange(new Set())}>
              Show everything
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
