"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TablePaginationBar } from "@/components/ui/table-pagination";
import { useTablePagination } from "@/lib/table-pagination";
import { cn } from "@/lib/utils";

/** The serialisable half of an Episode — dates as ISO, for the client. */
export type EpisodeRow = {
  id: number;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  cause: string | null;
  causeLabel: string;
  causeDetail: string;
  causeVariant: "danger" | "warning" | "secondary" | "outline";
  closeCode: number | null;
  closeReason: string | null;
  uptimeBefore: number | null;
  uptimeAfter: number | null;
  bootReason: string | null;
  sessionAfter: string | null;
  agentVersionBefore: string | null;
  agentVersionAfter: string | null;
  bundleId: string | null;
  bundleReady: boolean;
};

function forSeconds(seconds: number | null): string {
  if (seconds === null) return "ongoing";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Every stretch this box was out of contact, and what each one was.
 *
 * Rows expand rather than linking out, in the shape the rollout detail already
 * uses: the detail is six short facts, and a page of its own for each would be
 * six facts behind a navigation.
 */
export function DeviceConnectivity({ deviceId, rows }: { deviceId: string; rows: EpisodeRow[] }) {
  // `HUB_RESTART` rows are honest and they are not about the box, so they are
  // off by default rather than absent — somebody chasing a gap needs to be
  // able to see that Magnemite itself was the gap.
  const [showHub, setShowHub] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const visible = showHub ? rows : rows.filter((r) => r.cause !== "HUB_RESTART");
  const hubCount = rows.length - rows.filter((r) => r.cause !== "HUB_RESTART").length;
  const pagination = useTablePagination(visible, {
    pageSize: 25,
    resetKey: String(showHub),
  });

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing recorded in this window — the hub has not lost contact with this box.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {hubCount > 0 ? (
        <label className="flex items-center gap-2 self-end text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={showHub}
            onChange={(e) => setShowHub(e.target.checked)}
            className="h-3 w-3"
          />
          Show {hubCount} gap{hubCount === 1 ? "" : "s"} caused by Magnemite restarting
        </label>
      ) : null}

      <Table containerClassName="max-h-[32rem]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>When</TableHead>
            <TableHead>Out for</TableHead>
            <TableHead>What happened</TableHead>
            <TableHead>Logs</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pagination.rows.map((row) => (
            // Fragment with the key, not `<>`: the shorthand cannot carry one,
            // and a keyed child inside it is not the same thing — React keys
            // the list item, which is this pair of rows.
            <Fragment key={row.id}>
              <TableRow
                className={cn("cursor-pointer", open === row.id && "bg-subtle")}
                onClick={() => setOpen(open === row.id ? null : row.id)}
              >
                <TableCell>
                  {open === row.id ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </TableCell>
                <TableCell>
                  <RelativeTime value={row.startedAt} />
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {forSeconds(row.durationSeconds)}
                </TableCell>
                <TableCell>
                  <Badge variant={row.causeVariant}>{row.causeLabel}</Badge>
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {row.bundleReady && row.bundleId ? (
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/api/devices/${deviceId}/logs/${row.bundleId}`}>
                        <Download className="mr-1 h-3 w-3" />
                        zip
                      </Link>
                    </Button>
                  ) : row.bundleId ? (
                    <span className="text-xs text-muted-foreground">collection failed</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>

              {open === row.id ? (
                <TableRow>
                  <TableCell colSpan={5} className="bg-subtle p-0">
                    <div className="grid grid-cols-[10rem_minmax(0,1fr)] gap-x-4 gap-y-1 p-4 text-xs">
                      <Detail label="Why">{row.causeDetail}</Detail>
                      {row.closeCode !== null ? (
                        <Detail label="Socket closed">
                          code {row.closeCode}
                          {row.closeReason ? ` — ${row.closeReason}` : null}
                        </Detail>
                      ) : (
                        <Detail label="Socket">never closed</Detail>
                      )}
                      <Detail label="Uptime before → after">
                        {row.uptimeBefore === null ? "?" : forSeconds(row.uptimeBefore)} →{" "}
                        {row.uptimeAfter === null ? "?" : forSeconds(row.uptimeAfter)}
                      </Detail>
                      {row.bootReason ? (
                        <Detail label="Boot reason">
                          <code>{row.bootReason}</code>
                        </Detail>
                      ) : null}
                      {row.agentVersionBefore !== row.agentVersionAfter ? (
                        <Detail label="Agent version">
                          {row.agentVersionBefore ?? "?"} → {row.agentVersionAfter ?? "?"}
                        </Detail>
                      ) : null}
                      {row.sessionAfter ? (
                        <Detail label="Session after">
                          <code>{row.sessionAfter}</code> — grep agent.log for this
                        </Detail>
                      ) : null}
                      <Detail label="Ended">
                        {row.endedAt ? (
                          <RelativeTime value={row.endedAt} />
                        ) : (
                          "still out of contact"
                        )}
                      </Detail>
                    </div>
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          ))}
        </TableBody>
      </Table>

      <TablePaginationBar pagination={pagination} unit="episodes" />
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </>
  );
}
