"use client";

import { Cpu, Zap, Activity, Radio, Gauge } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export interface DirectStatusCardProps {
  deviceName: string;
  workerCount: number | null;
  workersInUse: number | null;
  requestRate?: number | null;
  versionName?: string | null;
  className?: string;
}

export function DirectStatusCard({
  deviceName,
  workerCount,
  workersInUse,
  requestRate,
  versionName,
  className,
}: DirectStatusCardProps) {
  const total = workerCount ?? 0;
  const inUse = workersInUse ?? 0;
  const percent = total > 0 ? Math.round((inUse / total) * 100) : 0;

  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between pb-2 space-y-0">
        <div className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-cyan-400" />
          <CardTitle className="text-base font-semibold">RPC Mode Engine</CardTitle>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className="border-cyan-500/50 bg-cyan-500/10 text-cyan-400 font-mono text-xs"
          >
            RPC Mode
          </Badge>
          <Badge
            variant="outline"
            className="border-emerald-500/50 bg-emerald-500/10 text-emerald-400 font-mono text-xs"
          >
            Active
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 text-sm">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Operating in Direct RPC mode with protocol worker sessions connected directly to Rotom.
        </p>

        {/* Worker High-Density Meter */}
        <div className="rounded-lg border border-border/80 bg-subtle p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium flex items-center gap-1.5 text-muted-foreground">
              <Gauge className="h-3.5 w-3.5 text-cyan-400" />
              High-Density Worker Capacity
            </span>
            <span className="font-mono text-foreground font-semibold">
              {total > 0 ? `${inUse} / ${total} active (${percent}%)` : "No workers attached"}
            </span>
          </div>
          <Progress value={percent} className="h-2" />
        </div>

        {/* Feature & Protection Metrics Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="flex items-start gap-2.5 rounded-md border border-border/60 p-2.5">
            <Cpu className="h-4 w-4 text-cyan-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-xs text-muted-foreground">Execution Model</div>
              <div className="font-medium text-xs">Direct RPC Protocol</div>
            </div>
          </div>

          <div className="flex items-start gap-2.5 rounded-md border border-border/60 p-2.5">
            <Radio className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-xs text-muted-foreground">Reported Version</div>
              <div className="font-mono text-xs truncate max-w-[140px]">
                {versionName ? `v${versionName.replace(/^v/, "")}` : "Connected"}
              </div>
            </div>
          </div>

          <div className="flex items-start gap-2.5 rounded-md border border-border/60 p-2.5">
            <Zap className="h-4 w-4 text-indigo-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-xs text-muted-foreground">Controller Link</div>
              <div className="font-medium text-xs">Rotom WebSocket</div>
            </div>
          </div>

          <div className="flex items-start gap-2.5 rounded-md border border-border/60 p-2.5">
            <Activity className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-xs text-muted-foreground">Throughput Rate</div>
              <div className="font-mono text-xs">
                {requestRate !== null && requestRate !== undefined
                  ? `${requestRate.toFixed(1)} req/s`
                  : inUse > 0
                  ? "Allocated"
                  : "Idle"}
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
