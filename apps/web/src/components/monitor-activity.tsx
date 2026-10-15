"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Binoculars, CircleCheck, Play, ChevronRight } from "lucide-react";
import { runMonitorNow } from "@/actions/monitoring";
import type { ActionState } from "@/actions/rollouts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SearchInput } from "@/components/ui/search-input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TablePaginationBar } from "@/components/ui/table-pagination";
import { RelativeTime } from "@/components/relative-time";
import { actionPastLabel, signalLabel } from "@/lib/monitor-vocabulary";
import { useTablePagination } from "@/lib/table-pagination";

export type MonitorActivityRow = {
  id: string;
  at: string;
  deviceId: string;
  deviceName: string;
  groupName: string | null;
  ruleName: string | null;
  signal: string;
  level: string;
  message: string;
  action: string | null;
  actionOk: boolean | null;
  detail: string | null;
  notified: boolean;
  /**
   * Whether this row is the all-clear rather than the fault.
   *
   * It is the only thing that distinguishes them, and the badge used to guess
   * from the level instead — so every fault on an INFO rule was painted green
   * and labelled "Recovered".
   */
  recovery: boolean;
};

const LEVEL_FILTER = [
  { value: "all", label: "Every severity" },
  { value: "CRITICAL", label: "Critical only" },
  { value: "WARN", label: "Warning and above" },
];

/**
 * What the rules actually did.
 *
 * A page of its own rather than a card in Settings, because it answers an
 * operational question — "why did that box reboot at 3am" — and not a
 * configuration one. It also grows: a fleet with monitoring on writes to this
 * all day, and a settings tab is not somewhere anyone goes to read a feed.
 */
export function MonitorActivity({
  events,
  enabled,
  ruleCount,
  canOperate,
}: {
  events: MonitorActivityRow[];
  /** Whether monitoring is switched on at all. */
  enabled: boolean;
  /** How many rules are enabled, so an empty feed is explicable. */
  ruleCount: number;
  canOperate: boolean;
}) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("all");
  const [state, setState] = useState<ActionState>({});
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase();
    return events.filter((event) => {
      if (level === "CRITICAL" && event.level !== "CRITICAL") return false;
      if (level === "WARN" && event.level === "INFO") return false;
      if (!words) return true;
      return `${event.deviceName} ${event.groupName ?? ""} ${event.ruleName ?? ""} ${
        event.message
      } ${event.detail ?? ""} ${event.action ?? ""}`
        .toLowerCase()
        .includes(words);
    });
  }, [events, query, level]);

  // The filters are the reset key, not the rows: the page live-refreshes every
  // few seconds, and a new array each poll would yank the reader back to
  // page one while they were reading page four.
  const pagination = useTablePagination(filtered, { resetKey: `${query}|${level}` });

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight">Monitoring</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What the rules saw and what they did about it. Configured in{" "}
            <Link href="/settings#monitoring" className="underline underline-offset-2">
              Settings → Monitoring
            </Link>
            .
          </p>
        </div>

        {canOperate ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => startTransition(async () => setState(await runMonitorNow()))}
          >
            <Play className="h-4 w-4" />
            Run a pass now
          </Button>
        ) : null}
      </header>

      <StatusStrip enabled={enabled} ruleCount={ruleCount} events={events} />

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search by box, rule or detail"
          aria-label="Search activity"
          className="max-w-xs"
        />
        <Select
          options={LEVEL_FILTER}
          value={level}
          onValueChange={setLevel}
          aria-label="Severity"
          className="w-48"
        />
      </div>

      {events.length === 0 ? (
        <Empty enabled={enabled} ruleCount={ruleCount} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Box</TableHead>
                  <TableHead>What happened</TableHead>
                  <TableHead>What was done</TableHead>
                  <TableHead className="text-right">When</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagination.rows.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell>
                      <Link
                        href={`/devices/${event.deviceId}`}
                        className="font-medium hover:underline"
                      >
                        {event.deviceName}
                      </Link>
                      {event.groupName ? (
                        <span className="block text-xs text-muted-foreground">
                          {event.groupName}
                        </span>
                      ) : null}
                    </TableCell>

                    <TableCell>
                      <span className="flex flex-wrap items-center gap-2">
                        <LevelBadge level={event.level} recovery={event.recovery} />
                        <span>{event.message}</span>
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {signalLabel(event.signal)}
                        {/* Whether it was announced, because a quiet Discord
                            with a busy feed is a question people ask. */}
                        {event.notified ? " · announced" : ""}
                      </span>
                      {event.detail ? (
                        // `title` so the truncated half is reachable without a
                        // primitive this codebase does not have.
                        <span
                          title={event.detail}
                          className="mt-1 block max-w-xl truncate font-mono text-xs text-muted-foreground"
                        >
                          {event.detail}
                        </span>
                      ) : null}
                    </TableCell>

                    <TableCell>
                      {event.action ? (
                        <Badge variant={event.actionOk === false ? "danger" : "secondary"}>
                          {actionPastLabel(event.action)}
                          {event.actionOk === false ? " — failed" : ""}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">nothing</span>
                      )}
                    </TableCell>

                    <TableCell className="whitespace-nowrap text-right text-xs text-muted-foreground">
                      <RelativeTime value={event.at} />
                    </TableCell>

                    <TableCell>
                      {/* To the page that can say why, with the window already
                          centred on this alert. A link rather than a drawer:
                          the correlation is server-rendered, so there is no
                          API to add — and the URL pastes into Discord, which
                          is where the alert was read in the first place. */}
                      <Button asChild variant="ghost" size="icon" aria-label="What happened">
                        <Link
                          href={`/devices/${event.deviceId}/connectivity?at=${encodeURIComponent(event.at)}`}
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <TablePaginationBar pagination={pagination} unit="events" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * Why the feed below looks the way it does.
 *
 * On a page of its own, an empty list is ambiguous in a way it never was in
 * Settings — where the master switch sat directly above it. "Nothing wrong all
 * day" and "this was never switched on" are opposite answers, so the page has
 * to say which one it is.
 */
function StatusStrip({
  enabled,
  ruleCount,
  events,
}: {
  enabled: boolean;
  ruleCount: number;
  events: MonitorActivityRow[];
}) {
  const dayAgo = Date.now() - 86_400_000;
  const recent = events.filter((event) => new Date(event.at).getTime() >= dayAgo);
  const acted = recent.filter((event) => event.action && event.action !== "NOTIFY_ONLY");
  const boxes = new Set(acted.map((event) => event.deviceId)).size;
  const failed = recent.filter((event) => event.actionOk === false).length;

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-3 py-4 text-sm">
        <span className="flex items-center gap-2">
          {enabled ? (
            <>
              <Binoculars className="h-4 w-4 text-primary" />
              <span>
                Watching, {ruleCount} {ruleCount === 1 ? "rule" : "rules"} on
              </span>
            </>
          ) : (
            <>
              <Binoculars className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Switched off</span>
            </>
          )}
        </span>

        <Stat label="Actions today" value={acted.length} />
        <Stat label="Boxes touched" value={boxes} />
        <Stat
          label="Failed actions"
          value={failed}
          // A failed action is the one number here that needs a person: the
          // rule fired, the box did not do what it was told.
          tone={failed > 0 ? "danger" : undefined}
        />
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "danger" }) {
  return (
    <span className="flex items-baseline gap-2">
      <span
        className={
          tone === "danger" ? "font-mono tabular-nums text-destructive" : "font-mono tabular-nums"
        }
      >
        {value}
      </span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function LevelBadge({ level, recovery }: { level: string; recovery: boolean }) {
  // Recovery first, and from the column that actually says so. Reading it off
  // the level meant an INFO *fault* — the seeded "Pogo not in focus" rule is
  // one — rendered as a green "Recovered", which is a straight lie in the one
  // place somebody goes to find out what happened.
  if (recovery) return <Badge variant="success">Recovered</Badge>;
  if (level === "CRITICAL") return <Badge variant="danger">Critical</Badge>;
  if (level === "WARN") return <Badge variant="warning">Warning</Badge>;
  return <Badge variant="info">Info</Badge>;
}

function Empty({ enabled, ruleCount }: { enabled: boolean; ruleCount: number }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
      <CircleCheck className="h-6 w-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {!enabled
          ? "Monitoring is switched off, so nothing is being watched."
          : ruleCount === 0
            ? "Monitoring is on, but no rule is enabled yet."
            : "Nothing to report. A rule that is on and finding nothing wrong is the quiet outcome."}
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href="/settings#monitoring">Open the rules</Link>
      </Button>
    </div>
  );
}
