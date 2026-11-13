"use client";

import { useEffect, useState, useTransition } from "react";
import { collectDeviceLogs, rebootDevice, rebootDevices } from "@/actions/devices";
import { DeviceExec } from "@/components/device-exec";
import { DeviceLiveLogs } from "@/components/device-live-logs";
import { DeviceMaintenance } from "@/components/device-maintenance";
import { DeviceScreenshot } from "@/components/device-screenshot";
import { RenameDevicesDialog } from "@/components/rename-devices-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import type { DeviceAction } from "@/lib/device-commands";
import type { ExecMitm } from "@/lib/mitm-columns";

/** One box, as much of it as any of the dialogs needs. */
export type DeviceTarget = {
  id: string;
  name: string;
  online: boolean;
  /** Whether its agent knows `collect_screenshot`. */
  canScreenshot: boolean;
  /** ISO string while the box is parked, null otherwise. */
  maintenanceUntil: string | null;
  /** The group's MITM, for the Execute dialog's config buttons. Operators only. */
  mitm: ExecMitm | null;
};

/**
 * Collecting takes as long as the box takes to zip and upload, so this says
 * what it is doing rather than looking broken for ten seconds.
 */
export function useLogcat() {
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  function download(deviceId: string) {
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

  return { download, pending };
}

/**
 * Every dialog a box's actions open, for whichever box they were opened on.
 *
 * Mounted by the page that owns the boxes — the device page with its one, the
 * Fleet with the row under the cursor or the selection — and fed live rows, so
 * a box that drops offline while a dialog is open is shown as offline.
 *
 * Each dialog is keyed by its box. Execute, the live logs and Rename all keep
 * what was typed or found between opens, which is the point on one page and a
 * leak across two: the log file discovered on one box would be followed on the
 * next.
 */
export function DeviceActionDialogs({
  action,
  targets,
  onClose,
}: {
  action: DeviceAction | null;
  /** One box for everything but Rename and Reboot, which take a selection. */
  targets: DeviceTarget[];
  onClose: () => void;
}) {
  const single = targets.length === 1 ? targets[0]! : null;
  const closeOn = (open: boolean) => {
    if (!open) onClose();
  };

  return (
    <>
      {single ? (
        <>
          <DeviceExec
            key={`exec:${single.id}`}
            deviceId={single.id}
            name={single.name}
            open={action === "exec"}
            onOpenChange={closeOn}
            mitm={single.mitm}
          />
          <DeviceLiveLogs
            key={`logs:${single.id}`}
            deviceId={single.id}
            name={single.name}
            open={action === "logs"}
            onOpenChange={closeOn}
          />
          {single.canScreenshot ? (
            <DeviceScreenshot
              key={`screenshot:${single.id}`}
              deviceId={single.id}
              name={single.name}
              open={action === "screenshot"}
              onOpenChange={closeOn}
            />
          ) : null}
          <DeviceMaintenance
            key={`maintenance:${single.id}`}
            deviceId={single.id}
            name={single.name}
            maintenanceUntil={single.maintenanceUntil}
            open={action === "maintenance"}
            onOpenChange={closeOn}
          />
        </>
      ) : null}

      {targets.length > 0 ? (
        <RenameDevicesDialog
          key={`rename:${targets.map((target) => target.id).join(",")}`}
          source={{ deviceIds: targets.map((target) => target.id) }}
          // Several boxes are numbered in the order they are listed; one box
          // has nothing to count, and its current name is what it is about.
          orders={single ? ["name"] : ["table", "serial", "name", "created"]}
          open={action === "rename"}
          onOpenChange={closeOn}
        />
      ) : null}

      <RebootConfirm targets={targets} open={action === "reboot"} onClose={onClose} />
    </>
  );
}

/**
 * Reboot asks first, every time and from everywhere.
 *
 * It used to go out on the first click — from the device menu, and from a
 * Fleet row with its result thrown away. A box rebooted by mistake is a scanner
 * down for minutes in somebody's living room, and with a key bound to it the
 * mistake is one finger away.
 */
function RebootConfirm({
  targets,
  open,
  onClose,
}: {
  targets: DeviceTarget[];
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const single = targets.length === 1 ? targets[0]! : null;
  const offline = targets.filter((target) => !target.online).length;
  const reachable = targets.length - offline;

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = single
        ? await rebootDevice(single.id)
        : await rebootDevices(targets.map((target) => target.id));
      if (result.error) {
        setError(result.error);
        return;
      }
      toast(result.message ?? "Reboot sent.");
      onClose();
    });
  }

  return (
    <ConfirmDialog
      open={open && targets.length > 0}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={single ? `Reboot ${single.name}?` : `Reboot ${targets.length} boxes?`}
      description={
        single
          ? "It restarts straight away. Whatever it is scanning stops, and it is out of contact until Android has booted — usually a minute or two."
          : "Each one restarts straight away and is out of contact until Android has booted. A box that is offline cannot be reached, and is skipped."
      }
      confirmLabel={single ? "Reboot" : `Reboot ${reachable}`}
      pendingLabel="Rebooting…"
      pending={pending}
      disabled={reachable === 0}
      error={error}
      onConfirm={confirm}
    >
      {single ? null : (
        <ul className="max-h-48 overflow-y-auto rounded-lg border border-border text-sm">
          {targets.map((target) => (
            <li
              key={target.id}
              className="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5 last:border-0"
            >
              <span className="truncate">{target.name}</span>
              {target.online ? null : (
                <span className="shrink-0 text-xs text-muted-foreground">offline — skipped</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </ConfirmDialog>
  );
}
