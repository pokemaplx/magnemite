"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps a server-rendered page in step with the fleet.
 *
 * The hub pushes an event whenever a device, job, rollout or version changes,
 * or a machine being provisioned moves on; this listens and asks Next to
 * re-render the current route. Refreshes are coalesced because a fleet-wide
 * rollout emits events far faster than anyone needs to see them — one repaint
 * per second is plenty.
 */
export function LiveRefresh({ throttleMs = 1000 }: { throttleMs?: number }) {
  const router = useRouter();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/events");

    const schedule = () => {
      if (pending.current) return;
      pending.current = setTimeout(() => {
        pending.current = null;
        router.refresh();
      }, throttleMs);
    };

    for (const kind of ["device", "job", "rollout", "version", "bootstrap"]) {
      source.addEventListener(kind, schedule);
    }
    // EventSource reconnects on its own; nothing to do but stop the noise.
    source.onerror = () => {};

    return () => {
      source.close();
      if (pending.current) clearTimeout(pending.current);
    };
  }, [router, throttleMs]);

  return null;
}
