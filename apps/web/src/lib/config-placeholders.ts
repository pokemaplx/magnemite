/**
 * What a device group's MITM config template may substitute.
 *
 * A plain array with no imports, deliberately. The dashboard needs this list in
 * two places that cannot share a dependency: a server action, to refuse an
 * unknown placeholder at Save, and a client component, to show the help text
 * under the field. `@magnemite/protocol` holds the same list, but importing it
 * here drags every zod schema in the wire protocol along with it, and
 * `@magnemite/db` drags Prisma — neither belongs in a browser bundle.
 *
 * The authority at runtime is the hub's `PLACEHOLDERS` map in
 * `apps/hub/src/services/deviceConfig.ts`, which is what actually renders a
 * config and refuses an unknown name. This list only decides what the dashboard
 * accepts and advertises: if the two ever drift, a template saves here and is
 * refused there, which is visible rather than silent. Keep them in step.
 */
export const CONFIG_PLACEHOLDERS = [
  "device.id",
  "device.name",
  "device.serial",
  "device.model",
  "device.manufacturer",
  "device.androidVersion",
  "device.abi",
  "device.localIp",
  "device.publicIp",
  "device.rotomOrigin",
  "device.rotomDeviceId",
  // Off the box's Redroid instance row, so a machine's capacity is a number
  // the dashboard owns rather than one hard-coded per group. Refused at render
  // on a box that is not a container, which is the same refusal every other
  // placeholder with no value gets.
  "device.workers",
  "group.name",
] as const;
