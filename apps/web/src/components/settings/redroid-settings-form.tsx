"use client";

import { useActionState, useEffect, useState } from "react";
import { Boxes } from "lucide-react";
import { updateRedroidSettings } from "@/actions/settings";
import type { ActionState } from "@/actions/rollouts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { SaveButton } from "@/components/ui/save-button";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { NumberField, SettingGroup } from "@/components/settings/setting-fields";

const GB = 1024 ** 3;

export type RedroidSettingsRow = {
  memLimitBytes: number;
  hostReserveBytes: number;
  workersPerInstance: number;
  workersPerVCpu: number;
  startBatchSize: number;
  gpuMode: string;
};

/** Bytes in, a number a person would type out. */
function toGb(bytes: number): number {
  return Math.round((bytes / GB) * 10) / 10;
}

/**
 * The container knobs, which had no screen at all until now.
 *
 * They have always been editable — `updateRedroidSettings` existed, with
 * nothing anywhere calling it — and the sentence that explains an empty
 * machine pointed operators at this tab to find them. It sent them to a page
 * where they were not, which is worse than not mentioning them: the arithmetic
 * that produced a zero was visible, and the two numbers that produced it were
 * reachable only through psql.
 *
 * Shown in gigabytes because that is the unit the machines' pages are written
 * in and the unit anyone sizing a VPS is thinking in. Stored in bytes, which
 * is what the compose file wants.
 */
export function RedroidSettingsForm({
  settings,
  disabled,
}: {
  settings: RedroidSettingsRow;
  disabled: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(updateRedroidSettings, {});
  const toast = useToast();
  // Controlled only so the arithmetic below can be redone as it is typed. The
  // numbers are the whole reason to be on this card, and a save that has to be
  // made before the consequence is visible is how a fleet gets tuned twice.
  const [memGb, setMemGb] = useState(toGb(settings.memLimitBytes));
  const [reserveGb, setReserveGb] = useState(toGb(settings.hostReserveBytes));

  useEffect(() => {
    if (state.ok && state.message) toast(state.message);
  }, [state, toast]);

  // What a machine would need to hold its first container, which is the
  // question these two numbers actually answer and the one the machines' pages
  // ask. Without it an operator is left doing the division by hand against a
  // page in another tab.
  const floorGb = memGb > 0 ? Math.round((reserveGb + memGb) * 10) / 10 : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Boxes className="h-4 w-4 text-muted-foreground" />
          Redroid containers
        </CardTitle>
        <CardDescription>
          How big a container is and how many a machine is planned to hold. A single machine can
          override its memory on its own page.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form action={formAction} className="flex flex-col gap-6">
          <SettingGroup
            title="Memory"
            hint={
              floorGb === null
                ? undefined
                : `At these two, a machine needs ${floorGb} GB of RAM before it fits a single container.`
            }
          >
            <NumberField
              name="memLimitGb"
              label="Memory per container"
              value={toGb(settings.memLimitBytes)}
              min={0.5}
              max={64}
              step="any"
              unit="GB"
              disabled={disabled}
              onValueChange={setMemGb}
              hint="A real ceiling: it is the container's mem_limit, so past it the OOM killer takes a box down rather than slowing it."
            />
            <NumberField
              name="hostReserveGb"
              label="Reserved for the machine"
              value={toGb(settings.hostReserveBytes)}
              min={0}
              max={64}
              step="any"
              unit="GB"
              disabled={disabled}
              onValueChange={setReserveGb}
              hint="Held back from the planning before containers are divided out. Zero is a real answer on a machine that runs nothing else."
            />
          </SettingGroup>

          <SettingGroup
            title="Workers"
            hint="The CPU half is advice rather than a limit — a machine past it is warned, never refused."
          >
            <NumberField
              name="workersPerInstance"
              label="Workers per container"
              value={settings.workersPerInstance}
              min={1}
              max={50}
              unit="workers"
              disabled={disabled}
              hint="What a new machine is given. 50 is where the scanners stop being happy, and on some licences the contractual ceiling."
            />
            <NumberField
              name="workersPerVCpu"
              label="Workers per vCPU"
              value={settings.workersPerVCpu}
              min={1}
              max={200}
              unit="workers"
              disabled={disabled}
              hint="The coefficient behind “N by cores” on a machine's page. Raise it if you have measured your own hardware and it is wrong."
            />
          </SettingGroup>

          <SettingGroup title="Starting up">
            <NumberField
              name="startBatchSize"
              label="Started at once"
              value={settings.startBatchSize}
              min={1}
              max={32}
              unit="containers"
              disabled={disabled}
              hint="How many a machine brings up per batch. An Android cold boot is heavy, and all of them at once is how a small machine falls over."
            />
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="gpuMode">GPU mode</Label>
              <Select
                id="gpuMode"
                name="gpuMode"
                defaultValue={settings.gpuMode}
                disabled={disabled}
                options={[
                  { value: "guest", label: "guest" },
                  { value: "host", label: "host" },
                  { value: "auto", label: "auto" },
                ]}
              />
              <p className="text-xs text-muted-foreground">
                <code>androidboot.redroid_gpu_mode</code>. <strong>guest</strong> is software
                rendering and is the one that works anywhere; the others need a GPU the container
                can actually reach.
              </p>
            </div>
          </SettingGroup>

          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

          {!disabled ? (
            <div className="flex flex-wrap items-center justify-end gap-3">
              {/* Said next to the button, because a save that looks like it
                  did nothing is the thing most likely to be done twice. */}
              <p className="text-xs text-muted-foreground">
                The memory ceiling reaches running containers only when a machine is re-applied.
              </p>
              <SaveButton state={state} />
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
