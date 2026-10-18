/**
 * What can be done to a box from its menu, its keys or the command palette.
 *
 * Its own module, apart from the dialogs that carry these out, because the
 * palette needs the names and the rules on every page and the dialogs only on
 * the two pages that open them.
 */
export type DeviceAction = "rename" | "exec" | "logs" | "screenshot" | "maintenance" | "reboot";

/** The same, plus the one that is a download rather than a dialog. */
export type DeviceCommand = DeviceAction | "logcat";

const COMMANDS: DeviceCommand[] = [
  "rename",
  "exec",
  "logs",
  "screenshot",
  "maintenance",
  "reboot",
  "logcat",
];

export function isDeviceCommand(value: string | null): value is DeviceCommand {
  return value !== null && (COMMANDS as string[]).includes(value);
}

/** The ones that travel the agent's socket, and so need the box connected. */
const NEEDS_SOCKET: DeviceCommand[] = ["exec", "logs", "screenshot", "reboot", "logcat"];

/**
 * Why a command cannot run on this box right now, or null when it can.
 *
 * The menu says the same thing by greying the item out. A key has no item to
 * grey, so it says it in words — pressing `e` on an offline box and seeing
 * nothing happen reads as a broken shortcut.
 */
export function commandBlocker(
  box: { name: string; online: boolean; canScreenshot: boolean },
  command: DeviceCommand,
): string | null {
  if (command === "screenshot" && !box.canScreenshot) {
    return `${box.name}'s agent is too old to take screenshots — update the agent first.`;
  }
  if (NEEDS_SOCKET.includes(command) && !box.online) return `${box.name} is offline.`;
  return null;
}
