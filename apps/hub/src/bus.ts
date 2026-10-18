import { EventEmitter } from "node:events";

/**
 * In-process fan-out for dashboard live updates. The SSE route subscribes,
 * the socket handlers and scheduler publish. Single hub process, so an
 * EventEmitter is enough — if the hub is ever scaled out this becomes a
 * Postgres LISTEN/NOTIFY bridge.
 */
export type BusEvent =
  | { kind: "device"; deviceId: string }
  | { kind: "job"; jobId: string; rolloutId: string; deviceId: string }
  | { kind: "rollout"; rolloutId: string }
  | { kind: "version"; versionId: string }
  // A machine being provisioned moved on: a step landed, or its state changed.
  // Its own kind because nothing else about the fleet changes while a VPS is
  // being set up, and the first machine is set up with no box online to
  // happen to refresh the page.
  | { kind: "bootstrap"; bootstrapId: string };

class Bus extends EventEmitter {
  publish(event: BusEvent) {
    this.emit("event", event);
  }

  subscribe(listener: (event: BusEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }
}

export const bus = new Bus();
// One listener per open dashboard tab. Node's default cap of 10 is only there
// to catch leaks, and every listener here is unsubscribed on disconnect, so
// there is no reason to put a ceiling on how many tabs may be open.
bus.setMaxListeners(0);
