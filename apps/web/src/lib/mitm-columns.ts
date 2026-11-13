/**
 * The MITM version columns, derived from the device groups.
 *
 * Each group names the MITM its boxes run, and that is where the column comes
 * from — Magnemite installs these and writes their config, but nothing polls a
 * feed for them, so their version is reported rather than tracked.
 *
 * Two groups may name the same package: two sites on Aegis, pointed at two
 * Rotom instances by their own configs. That is one column, not two, or a fleet
 * with five sites grows five identical ones.
 */
export type MitmColumn = { packageName: string; label: string };

export type GroupMitm = {
  name: string;
  mitmPackageName: string | null;
  mitmLabel: string | null;
};

/** What a group calls its MITM: its own label, or the last dotted segment of the package. */
function mitmLabel(packageName: string, label: string | null): string {
  return label || (packageName.split(".").pop() ?? packageName);
}

/** One column per distinct package, ordered by the group that first names it. */
export function mitmColumns(groups: GroupMitm[]): MitmColumn[] {
  const byPackage = new Map<string, string>();
  for (const group of [...groups].sort((a, b) => a.name.localeCompare(b.name))) {
    const packageName = group.mitmPackageName;
    if (!packageName || byPackage.has(packageName)) continue;
    byPackage.set(packageName, mitmLabel(packageName, group.mitmLabel));
  }
  return [...byPackage].map(([packageName, label]) => ({ packageName, label }));
}

/** A box's group MITM, as far as the Execute dialog needs it. */
export type ExecMitm = {
  /** The group's column header, or the last dotted segment of the package. */
  label: string;
  packageName: string;
  /** Where the group writes its config. Null when it declares none. */
  configPath: string | null;
};

/**
 * The Execute dialog's view of a group. Null when the group runs no MITM, or
 * there is no group.
 *
 * Only ever handed to operators: the dialog's config view shows the config,
 * which is the MITM's credentials.
 */
export function execMitm(
  group: Pick<GroupMitm, "mitmPackageName" | "mitmLabel"> & { mitmConfigPath: string | null },
): ExecMitm | null {
  if (!group.mitmPackageName) return null;
  return {
    label: mitmLabel(group.mitmPackageName, group.mitmLabel),
    packageName: group.mitmPackageName,
    configPath: group.mitmConfigPath,
  };
}
