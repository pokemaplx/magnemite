// The default import, not `{ version }`: a JSON module only has a default
// export, and the bundler warns that its named-export support is going away.
import nextPackage from "next/package.json";
import { prisma } from "@magnemite/db";
import { requireUser } from "@/lib/session";
import { hub, type HubHealth } from "@/lib/hub";
import { WEB_VERSION } from "@/lib/version";
import { StatusBoard } from "@/components/status-board";

const nextVersion = nextPackage.version;

export const dynamic = "force-dynamic";

/**
 * When the hub is the thing that is down, its own probes are unavailable —
 * but the dashboard talks to the database directly, so it can still answer
 * the next question an operator asks: is this the hub, or is it everything?
 */
async function fallbackHealth(error: string): Promise<HubHealth> {
  const engine = process.env.DB_PROVIDER === "mysql" ? "MariaDB/MySQL" : "Postgres";
  const started = Date.now();
  let database: HubHealth["checks"][number];

  try {
    const devices = await prisma.device.count({ where: { kind: "BOX" } });
    database = {
      key: "database",
      label: "Database",
      summary: `${engine} answering in ${Date.now() - started} ms (checked from the dashboard)`,
      state: "OK",
      latencyMs: Date.now() - started,
      facts: [{ label: "Devices", value: String(devices) }],
      detail: null,
      link: null,
    };
  } catch (err) {
    database = {
      key: "database",
      label: "Database",
      summary: `${engine} is not answering the dashboard either`,
      state: "DOWN",
      latencyMs: null,
      facts: [],
      detail: err instanceof Error ? err.message : String(err),
      link: null,
    };
  }

  return {
    checkedAt: new Date().toISOString(),
    overall: "DOWN",
    checks: [
      {
        key: "hub",
        label: "Hub",
        summary: "Not reachable from the dashboard",
        state: "DOWN",
        latencyMs: null,
        facts: [{ label: "HUB_URL", value: process.env.HUB_URL ?? "http://localhost:3001" }],
        detail: error,
        link: null,
      },
      database,
    ],
  };
}

/**
 * The dashboard's own card.
 *
 * Every other check is a probe the hub runs; this one is the process rendering
 * the page, so it answers here. It is always OK by definition — if it were
 * not, there would be no page — and exists for its versions: a dashboard and a
 * hub left on different releases is a real state to be in, and this is where
 * you would notice.
 */
function dashboardCheck(): HubHealth["checks"][number] {
  return {
    key: "web",
    label: "Dashboard",
    summary: `Serving this page on Next.js ${nextVersion}`,
    state: "OK",
    latencyMs: null,
    facts: [
      { label: "Dashboard", value: WEB_VERSION },
      { label: "Next.js", value: nextVersion },
      { label: "Node", value: process.version },
    ],
    detail: null,
    link: null,
  };
}

export default async function StatusPage() {
  await requireUser();

  try {
    const health = await hub.health();
    return (
      <StatusBoard
        health={{ ...health, checks: [dashboardCheck(), ...health.checks] }}
        error={null}
      />
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const health = await fallbackHealth(message);
    return (
      <StatusBoard
        health={{ ...health, checks: [dashboardCheck(), ...health.checks] }}
        error={message}
      />
    );
  }
}
