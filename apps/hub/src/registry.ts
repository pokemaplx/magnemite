import type { WebSocket } from "ws";
import type { ServerMessage } from "@magnemite/protocol";
import { log } from "./log.js";

export type Connection = {
  deviceId: string;
  serial: string;
  socket: WebSocket;
  remoteIp: string | null;
  agentVersion: string | null;
  /** ro.product.cpu.abi, so an agent update picks the right binary. */
  abi: string | null;
  /**
   * The agent's own id for this connection, from its hello.
   *
   * Lives here rather than on the Device row because it describes the socket,
   * not the box: it is what lets a connectivity episode name the stretch of
   * the box's agent.log that explains it. Null from an older agent.
   */
  sessionId: string | null;
  connectedAt: number;
  lastSeenAt: number;
  /** Job the agent says it is running right now, from hello/heartbeat. */
  currentJobId: string | null;
  send: (msg: ServerMessage) => void;
};

const connections = new Map<string, Connection>();

export function register(conn: Connection) {
  const existing = connections.get(conn.deviceId);
  if (existing && existing.socket !== conn.socket) {
    // A box that lost power mid-session reconnects before the old socket has
    // timed out. Newest wins; the stale one is closed so we never hold two
    // sockets for one device and dispatch a job down the dead one.
    log.info({ deviceId: conn.deviceId }, "replacing stale connection");
    try {
      existing.socket.close(4000, "replaced by newer connection");
    } catch {
      /* already gone */
    }
  }
  connections.set(conn.deviceId, conn);
}

export function unregister(deviceId: string, socket: WebSocket) {
  const existing = connections.get(deviceId);
  // Only drop it if the socket closing is the one currently registered —
  // otherwise a late close event from a replaced socket would evict the live one.
  if (existing && existing.socket === socket) connections.delete(deviceId);
}

export function getConnection(deviceId: string): Connection | undefined {
  return connections.get(deviceId);
}

export function isOnline(deviceId: string): boolean {
  return connections.has(deviceId);
}

export function listConnections(): Connection[] {
  return [...connections.values()];
}

export function onlineDeviceIds(): string[] {
  return [...connections.keys()];
}

export function connectionCount(): number {
  return connections.size;
}

export function sendTo(deviceId: string, msg: ServerMessage): boolean {
  const conn = connections.get(deviceId);
  if (!conn) return false;
  try {
    conn.send(msg);
    return true;
  } catch (err) {
    log.warn({ err, deviceId, type: msg.type }, "send failed");
    return false;
  }
}
