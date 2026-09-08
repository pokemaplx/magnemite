import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1),
  /** Which Prisma connector the database speaks. "mysql" also covers MariaDB. */
  DB_PROVIDER: z.enum(["postgresql", "mysql"]).default("postgresql"),
  HUB_PORT: z.coerce.number().int().positive().default(3001),
  HUB_HOST: z.string().default("0.0.0.0"),
  /** Shared secret the dashboard uses on /internal/* calls. */
  HUB_INTERNAL_SECRET: z.string().min(8),
  /** Base URL agents see. Artifact URLs are built from this. */
  MAGNEMITE_PUBLIC_URL: z.string().url(),
  /**
   * Where a person reaches the dashboard. Only alert links are built from it,
   * and it is optional because a single-domain deployment has nowhere else to
   * point them -- but on Coolify the two are different hosts, and the agents'
   * one serves four routes and 404s everything else.
   */
  MAGNEMITE_DASHBOARD_URL: z.string().url().optional(),
  ARTIFACT_DIR: z.string().default("/data/artifacts"),
  /**
   * Serve /files/* from the hub itself. Off in production, where Caddy does
   * it off the shared volume without Node in the data path.
   */
  SERVE_ARTIFACTS: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  /**
   * Agent self-update. The hub image ships the binaries it wants the fleet to
   * run, so a box that reconnects on an older build is told to update itself.
   * Turn it off to pin the fleet and drive updates by hand instead.
   */
  AGENT_AUTO_UPDATE: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
  /** Where those binaries live, next to the VERSION they were built from. */
  AGENT_BIN_DIR: z.string().default("/app/agent-bin"),
  // How many boxes may swap their binary at once, and how long a box may go
  // quiet before it counts as offline, both live in Settings → Tuning, not here.

  /**
   * Web push. The keypair identifies this server to every push service the
   * fleet's browsers happen to use, so it has to outlive a deploy and be the
   * same for everyone -- which is what keeps it here rather than in
   * Settings: a regenerated key silently invalidates every subscription, and
   * a form makes that one click away.
   *
   * Generate once with `npx web-push generate-vapid-keys`. Absent is not an
   * error: web push simply stays unavailable, and the dashboard says so
   * rather than offering a button that cannot work.
   */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  /**
   * Contact address for the push service to reach if this server misbehaves.
   * Required by the VAPID spec as a `mailto:` or `https:` URL; push services
   * reject a JWT without one.
   */
  VAPID_SUBJECT: z.string().default("mailto:admin@example.com"),

  ROTOM_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  ROTOM_URL: z.string().optional(),
  ROTOM_SECRET: z.string().optional(),
  /**
   * BasicAuth for a reverse proxy in front of Rotom. Independent of
   * `ROTOM_SECRET`: a proxy that gates the whole listener wants the
   * `Authorization` header, Rotom itself wants `X-Rotom-Secret`, and a Rotom
   * published behind such a proxy needs both at once. Set whichever the
   * deployment actually has.
   */
  ROTOM_BASIC_USERNAME: z.string().optional(),
  ROTOM_BASIC_PASSWORD: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid hub environment:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
