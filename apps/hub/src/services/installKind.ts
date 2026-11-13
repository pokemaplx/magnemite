import { COSMOG_PACKAGE, GAME_PACKAGE } from "@magnemite/apk";
import type { InstallJob } from "@magnemite/protocol";

/**
 * What installing `packageName` means on a box whose group runs `mitmPackageName`.
 *
 * Null is an APK through `pm`, which is everything but two cases:
 *
 * - Cosmog itself, which is a binary and its `libart.so` unpacked into a
 *   directory, on any box.
 * - The game on a Cosmog box. Cosmog does not run the app; it loads the game's
 *   own library and reads its APKs off disk, which is what aconf's `pogo_lib`
 *   puts there. So the same build every other group installs is, here,
 *   unpacked beside Cosmog -- one version, one rollout, two meanings.
 */
export function installKind(
  packageName: string,
  mitmPackageName: string | null,
): InstallJob["kind"] {
  if (packageName === COSMOG_PACKAGE) return "cosmog";
  if (packageName === GAME_PACKAGE && mitmPackageName === COSMOG_PACKAGE) return "cosmog_game";
  return null;
}
