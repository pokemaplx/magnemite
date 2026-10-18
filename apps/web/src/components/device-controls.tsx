"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
import { deleteDevice, setDeviceApproval, setDeviceGroup } from "@/actions/devices";
import { DeviceActionDialogs, useLogcat, type DeviceTarget } from "@/components/device-actions";
import { useHotkey } from "@/components/shortcuts/hotkeys";
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
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import {
  commandBlocker,
  isDeviceCommand,
  type DeviceAction,
  type DeviceCommand,
} from "@/lib/device-commands";
import type { ExecMitm } from "@/lib/mitm-columns";
import { primaryKey } from "@/lib/shortcuts";

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
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [action, setAction] = useState<DeviceAction | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const logcat = useLogcat();

  const parked = maintenanceUntil !== null && new Date(maintenanceUntil).getTime() > Date.now();
  const target: DeviceTarget = {
    id: deviceId,
    name,
    online,
    canScreenshot,
    maintenanceUntil,
    mitm,
  };

  function start(command: DeviceCommand) {
    const blocker = commandBlocker(target, command);
    if (blocker) {
      toast(blocker);
      return;
    }
    if (command === "logcat") logcat.download(deviceId);
    else setAction(command);
  }

  // The menu's items, on keys. Bound while this page is open; what the menu
  // greys out, a key explains in a toast instead.
  useHotkey("device.rename", () => start("rename"));
  useHotkey("device.exec", () => start("exec"));
  useHotkey("device.logs", () => start("logs"));
  useHotkey("device.screenshot", () => start("screenshot"));
  useHotkey("device.logcat", () => start("logcat"));
  useHotkey("device.maintenance", () => start("maintenance"));
  useHotkey("device.reboot", () => start("reboot"));

  // `?action=exec` is how the palette opens one of these on a box from
  // anywhere else. Run once, then taken back off the URL so that a reload or
  // the back button does not open it a second time. The ref is for
  // StrictMode, which runs this twice — twice would be two logcat downloads.
  const requested = searchParams.get("action");
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!requested) {
      handled.current = null;
      return;
    }
    if (handled.current === requested) return;
    handled.current = requested;
    window.history.replaceState(null, "", pathname);
    if (isDeviceCommand(requested)) start(requested);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested]);

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
            <Button
              variant="outline"
              disabled={pending || logcat.pending}
              aria-label="Device actions"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuItem onSelect={() => start("rename")}>
              <Pencil />
              Rename
              <DropdownMenuShortcut keys={primaryKey("device.rename")} />
            </DropdownMenuItem>

            {/* Nothing Rotom-shaped here. Those actions travel Rotom's socket
                rather than the agent's, which is the whole reason to reach for
                one — and beside a Reboot that needs the agent alive, the two
                kinds of reboot read as duplicates. They live on the scanner
                page, behind the button in the Agent card. */}

            <DropdownMenuItem disabled={!online} onSelect={() => start("exec")}>
              <Terminal />
              Execute
              <DropdownMenuShortcut keys={primaryKey("device.exec")} />
            </DropdownMenuItem>

            <DropdownMenuItem disabled={!online} onSelect={() => start("logs")}>
              <Radio />
              Live logs
              <DropdownMenuShortcut keys={primaryKey("device.logs")} />
            </DropdownMenuItem>

            {/* Left out entirely rather than disabled on an agent too old for
                it: a greyed item invites a hover for a reason it cannot give,
                and the fix is an agent update rather than anything on this
                menu. */}
            {canScreenshot ? (
              <DropdownMenuItem disabled={!online} onSelect={() => start("screenshot")}>
                <Camera />
                Screenshot
                <DropdownMenuShortcut keys={primaryKey("device.screenshot")} />
              </DropdownMenuItem>
            ) : null}

            <DropdownMenuItem disabled={!online} onSelect={() => start("logcat")}>
              <ScrollText />
              Logcat (.zip)
              <DropdownMenuShortcut keys={primaryKey("device.logcat")} />
            </DropdownMenuItem>

            <DropdownMenuItem disabled={!online} onSelect={() => start("reboot")}>
              <Power />
              Reboot…
              <DropdownMenuShortcut keys={primaryKey("device.reboot")} />
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* Not disabled when the box is offline. Parking one that is not
                answering is exactly what somebody about to go and unplug it
                wants, and the hook simply does not run — which the dialog
                says. */}
            <DropdownMenuItem onSelect={() => start("maintenance")}>
              <Wrench />
              {parked ? "End maintenance" : "Maintenance…"}
              <DropdownMenuShortcut keys={primaryKey("device.maintenance")} />
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

      {/* Controlled rather than triggered, because the menu item that opens
          each of them is unmounted by Radix the moment it is selected. Rename
          is the same dialog the fleet table opens, with one box in it: the
          collision check against the rest of the fleet, and the name the box's
          own MITM config already uses. */}
      <DeviceActionDialogs action={action} targets={[target]} onClose={() => setAction(null)} />

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
