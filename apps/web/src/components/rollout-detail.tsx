"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, PlayCircle, RefreshCw, RotateCcw, XCircle } from "lucide-react";
import type { InstallMode, JobState, LogLevel, RolloutStatus } from "@magnemite/db";
import {
  cancelJobAction,
  cancelRolloutAction,
  resumeRolloutAction,
  retryFailedAction,
  retryJobAction,
} from "@/actions/rollouts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TablePaginationBar } from "@/components/ui/table-pagination";
import { ACTIVE_JOB_STATES, JobStateBadge, OnlineDot } from "@/components/status";
import { formatDuration } from "@/lib/format";
import { useTablePagination } from "@/lib/table-pagination";
import { cn } from "@/lib/utils";

export type JobRow = {
  id: string;
  deviceId: string;
  deviceName: string;
  deviceOnline: boolean;
  groupName: string | null;
  state: JobState;
  progress: number;
  isCanary: boolean;
  attempt: number;
  lastError: string | null;
  dataWiped: boolean;
  installMode: InstallMode | null;
  fromVersion: string | null;
  toVersion: string;
  startedAt: string | null;
  finishedAt: string | null;
  events: { ts: string; level: LogLevel; phase: JobState | null; message: string }[];
};

const ROLLOUT_OVER: RolloutStatus[] = ["COMPLETED", "CANCELLED"];

export function RolloutActions({
  rolloutId,
  status,
  failedCount,
}: {
  rolloutId: string;
  status: RolloutStatus;
  failedCount: number;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(fn: () => Promise<{ error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result?.error) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        {failedCount > 0 ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => run(() => retryFailedAction(rolloutId))}
          >
            <RotateCcw />
            Retry {failedCount} failed
          </Button>
        ) : null}

        {status === "PAUSED" || status === "SOAKING" || status === "PENDING" ? (
          <Button disabled={pending} onClick={() => run(() => resumeRolloutAction(rolloutId))}>
            <PlayCircle />
            {status === "SOAKING"
              ? "Release fleet now"
              : status === "PENDING"
                ? "Start now"
                : "Resume anyway"}
          </Button>
        ) : null}

        {!ROLLOUT_OVER.includes(status) ? (
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => run(() => cancelRolloutAction(rolloutId))}
          >
            <XCircle />
            Cancel
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function RolloutJobs({
  jobs,
  rolloutId,
  canOperate,
}: {
  jobs: JobRow[];
  rolloutId: string;
  canOperate: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const pagination = useTablePagination(jobs, { resetKey: rolloutId });

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <Table containerClassName="max-h-[60vh]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Device</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="min-w-48">Progress</TableHead>
            <TableHead>From → to</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead className="w-32" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {pagination.rows.map((job) => (
            <JobRowView
              key={job.id}
              job={job}
              rolloutId={rolloutId}
              canOperate={canOperate}
              expanded={expanded === job.id}
              onToggle={() => setExpanded(expanded === job.id ? null : job.id)}
            />
          ))}
        </TableBody>
      </Table>
      <TablePaginationBar pagination={pagination} unit="devices" />
    </div>
  );
}

function JobRowView({
  job,
  rolloutId,
  canOperate,
  expanded,
  onToggle,
}: {
  job: JobRow;
  rolloutId: string;
  canOperate: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const active = ACTIVE_JOB_STATES.includes(job.state);

  return (
    <>
      <TableRow>
        <TableCell>
          <button
            type="button"
            onClick={onToggle}
            className="text-muted-foreground hover:text-foreground"
            aria-label={expanded ? "Hide log" : "Show log"}
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </TableCell>

        <TableCell>
          <div className="flex items-center gap-2">
            <OnlineDot online={job.deviceOnline} />
            <div className="min-w-0">
              <Link
                href={`/devices/${job.deviceId}`}
                className="block truncate font-medium hover:underline"
              >
                {job.deviceName}
              </Link>
              <div className="text-xs text-muted-foreground">
                {job.groupName ?? "—"}
                {job.isCanary ? " · canary" : ""}
                {job.attempt > 1 ? ` · attempt ${job.attempt}` : ""}
              </div>
            </div>
          </div>
        </TableCell>

        <TableCell>
          <div className="flex flex-wrap items-center gap-1">
            <JobStateBadge state={job.state} />
            {job.dataWiped ? <Badge variant="warning">data wiped</Badge> : null}
          </div>
        </TableCell>

        <TableCell>
          {active ? (
            <Progress value={job.progress} />
          ) : job.state === "FAILED" ? (
            <span
              className="line-clamp-2 text-xs text-destructive"
              title={job.lastError ?? undefined}
            >
              {job.lastError ?? "failed"}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </TableCell>

        <TableCell className="font-mono text-xs text-muted-foreground">
          {job.fromVersion ?? "none"} → {job.toVersion}
        </TableCell>

        <TableCell className="text-xs text-muted-foreground">
          {formatDuration(
            job.startedAt ? new Date(job.startedAt) : null,
            job.finishedAt ? new Date(job.finishedAt) : null,
          )}
        </TableCell>

        <TableCell>
          {canOperate ? (
            <div className="flex justify-end gap-1">
              {active || job.state === "QUEUED" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => startTransition(() => void cancelJobAction(job.id, rolloutId))}
                >
                  <XCircle />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => startTransition(() => void retryJobAction(job.id, rolloutId))}
                  title="Retry on this device"
                >
                  <RefreshCw />
                </Button>
              )}
            </div>
          ) : null}
        </TableCell>
      </TableRow>

      {expanded ? (
        <TableRow>
          <TableCell colSpan={7} className="bg-subtle p-0">
            <div className="max-h-72 overflow-y-auto p-3">
              {job.events.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing logged yet.</p>
              ) : (
                <ol className="flex flex-col gap-0.5 font-mono text-xs">
                  {job.events.map((event, index) => (
                    <li
                      key={`${event.ts}-${index}`}
                      className="grid grid-cols-[auto_7rem_minmax(0,1fr)] gap-3"
                    >
                      <span className="text-muted-foreground">
                        {new Date(event.ts).toLocaleTimeString()}
                      </span>
                      <span
                        className={cn(
                          "truncate",
                          event.level === "ERROR" && "text-destructive",
                          event.level === "WARN" && "text-warning",
                          event.level === "DEBUG" && "text-muted-foreground",
                        )}
                      >
                        {event.phase?.toLowerCase() ?? event.level.toLowerCase()}
                      </span>
                      <span className="break-all">{event.message}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
