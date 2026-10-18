"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Camera,
  MoreHorizontal,
  Pencil,
  Power,
  Radio,
  ScrollText,
  ShieldCheck,
  ShieldOff,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";
import {
  collectDeviceLogs,
  deleteDevice,
  rebootDevice,
  setDeviceApproval,
  setDeviceGroup,
} from "@/actions/devices";
import { DeviceExec, type ExecMitm } from "@/components/device-exec";
import { DeviceLiveLogs } from "@/components/device-live-logs";
import { DeviceMaintenance } from "@/components/device-maintenance";
import { DeviceScreenshot } from "@/components/device-screenshot";
import { RenameDevicesDialog } from "@/components/rename-devices-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";

export function DeviceControls({
  deviceId,
  name,
  approved,
  online,
  groupId,
  groups,
  maintenanceUntil,
  canScreenshot,
  mitm,
}: {
  deviceId: string;
  name: string;
  approved: boolean;
  online: boolean;
  groupId: string | null;
  groups: { id: string; name: string }[];
  /** ISO string while the box is parked, null otherwise. */
  maintenanceUntil: string | null;
  /**
   * Whether this box's agent knows `collect_screenshot`. False leaves the item
   * out rather than offering a button that waits half a minute and then says
   * the box never answered, which is what an unknown message looks like from
   * here.
   */
  canScreenshot: boolean;
  /**
   * The group's MITM, for the Execute dialog's config buttons. Passed only to
   * operators, as this whole component is: rewriting it shows the config,
   * which is the MITM's credentials.
   */
  mitm: ExecMitm | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [liveLogs, setLiveLogs] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [screenshot, setScreenshot] = useState(false);
  const [maintaining, setMaintaining] = useState(false);

  const parked = maintenanceUntil !== null && new Date(maintenanceUntil).getTime() > Date.now();

  /**
   * Collecting takes as long as the box takes to zip and upload, so the menu
   * item says what it is doing rather than looking broken for ten seconds.
   */
  function downloadLogs() {
    toast("Collecting logs from the box…");
    startTransition(async () => {
      const result = await collectDeviceLogs(deviceId);
      if (result.error || !result.bundleId) {
        toast(result.error ?? "The box sent nothing back.", "error");
        return;
      }
      toast("Logs ready — downloading.");
      window.location.href = `/api/devices/${deviceId}/logs/${result.bundleId}`;
    });
  }

  function run(fn: () => Promise<{ error?: string; message?: string }>, after?: () => void) {
    startTransition(async () => {
      const result = await fn();
      if (result?.error) toast(result.error, "error");
      else if (result?.message) toast(result.message);
      if (!result?.error) after?.();
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {/* Only the two controls used on every visit stay out here; the rest —
          rename, reboot, remove — sit behind the menu so the header stays calm. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Select
          aria-label="Group"
          placeholder="Select group…"
          value={groupId ?? ""}
          disabled={pending}
          className="w-40"
          options={[
            { value: "", label: "No group" },
            ...groups.map((g) => ({ value: g.id, label: g.name })),
          ]}
          onValueChange={(value) => run(() => setDeviceGroup(deviceId, value))}
        />

        {!approved ? (
          <Button disabled={pending} onClick={() => run(() => setDeviceApproval(deviceId, true))}>
            <ShieldCheck />
            Approve
          </Button>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" disabled={pending} aria-label="Device actions">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <Pencil />
              Rename
            </DropdownMenuItem>

            {/* Nothing Rotom-shaped here. Those actions travel Rotom's socket
                rather than the agent's, which is the whole reason to reach for
                one — and beside a Reboot that needs the agent alive, the two
                kinds of reboot read as duplicates. They live on the scanner
                page, behind the button in the Agent card. */}

            <DropdownMenuItem disabled={!online} onSelect={() => setExecuting(true)}>
              <Terminal />
              Execute
            </DropdownMenuItem>

            <DropdownMenuItem disabled={!online} onSelect={() => setLiveLogs(true)}>
              <Radio />
              Live logs
            </DropdownMenuItem>

            {/* Left out entirely rather than disabled on an agent too old for
                it: a greyed item invites a hover for a reason it cannot give,
                and the fix is an agent update rather than anything on this
                menu. */}
            {canScreenshot ? (
              <DropdownMenuItem disabled={!online} onSelect={() => setScreenshot(true)}>
                <Camera />
                Screenshot
              </DropdownMenuItem>
            ) : null}

            <DropdownMenuItem disabled={!online} onSelect={() => downloadLogs()}>
              <ScrollText />
              Logcat (.zip)
            </DropdownMenuItem>

            <DropdownMenuItem disabled={!online} onSelect={() => run(() => rebootDevice(deviceId))}>
              <Power />
              Reboot
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* Not disabled when the box is offline. Parking one that is not
                answering is exactly what somebody about to go and unplug it
                wants, and the hook simply does not run — which the dialog
                says. */}
            <DropdownMenuItem onSelect={() => setMaintaining(true)}>
              <Wrench />
              {parked ? "End maintenance" : "Maintenance…"}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {approved ? (
              <DropdownMenuItem onSelect={() => run(() => setDeviceApproval(deviceId, false))}>
                <ShieldOff />
                Unapprove
              </DropdownMenuItem>
            ) : null}

            <DropdownMenuItem destructive onSelect={() => setConfirmDelete(true)}>
              <Trash2 />
              Remove device
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <DeviceExec
        deviceId={deviceId}
        name={name}
        open={executing}
        onOpenChange={setExecuting}
        mitm={mitm}
      />

      <DeviceLiveLogs deviceId={deviceId} name={name} open={liveLogs} onOpenChange={setLiveLogs} />

      <DeviceScreenshot
        deviceId={deviceId}
        name={name}
        open={screenshot}
        onOpenChange={setScreenshot}
      />

      <DeviceMaintenance
        deviceId={deviceId}
        name={name}
        maintenanceUntil={maintenanceUntil}
        open={maintaining}
        onOpenChange={setMaintaining}
      />

      {/* The same dialog the fleet table opens, with one box in it. It used to
          be a bare name field here, which quietly cost this page everything
          the other one had learned: the collision check against the rest of
          the fleet, and reading the name the box's own MITM config already
          uses. Controlled rather than triggered, because the menu item that
          opens it is unmounted by Radix the moment it is selected. */}
      <RenameDevicesDialog
        source={{ deviceIds: [deviceId] }}
        orders={["name"]}
        open={renaming}
        onOpenChange={setRenaming}
      />

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {name}?</DialogTitle>
            <DialogDescription>
              Its token stops working immediately and its update history is deleted. The box itself
              is untouched — it will keep retrying until you re-enroll it or remove the Magisk
              module.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() =>
                run(
                  () => deleteDevice(deviceId),
                  () => router.push("/"),
                )
              }
            >
              Remove device
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
