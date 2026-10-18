/**
 * What a box's MITM config still says about workers, when that is not what the
 * box is configured for -- the gap the hub's `workersConfig.ts` closes by
 * rewriting the config.
 *
 * Only a box that enrolled has a config, and a null `configWorkers` is
 * "nothing written yet", which is not behind: the install that brings its MITM
 * writes the first one.
 */
export function configBehind(
  instance: { deviceId: string | null; configWorkers: number | null },
  workers: number,
): number | null {
  if (instance.deviceId === null || instance.configWorkers === null) return null;
  return instance.configWorkers === workers ? null : instance.configWorkers;
}
