import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  CloudDownload,
  GitBranch,
  PlugZap,
  RadioTower,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import logo from "@/public/magnemite.png";

const stats = [
  { value: "1 → N", label: "boxes per rollout" },
  { value: "1×", label: "download per release" },
  { value: "0", label: "ports open on the LAN" },
  { value: "~6 MB", label: "agent on the box" },
];

const features = [
  {
    icon: RadioTower,
    title: "No open ports",
    body: "Boxes dial out over WSS. NAT, CGNAT and changing IPs are somebody else's problem, and nothing on the LAN is exposed.",
  },
  {
    icon: CloudDownload,
    title: "Cached once",
    body: "The hub downloads each .apkm a single time, hashes it, and Caddy streams it off the volume. Node never sits in the data path.",
  },
  {
    icon: GitBranch,
    title: "Canary first",
    body: "A few boxes update alone. A failed canary parks the rollout at PAUSED instead of pushing a bad build to two hundred devices.",
  },
  {
    icon: PlugZap,
    title: "Retries by itself",
    body: "Offline, stalled and failed jobs come back without anyone watching. The bytes already on disk make the retry cheap.",
  },
  {
    icon: SquareTerminal,
    title: "A fleet without hardware",
    body: "The agent's -fake-root mode stubs pm and dumpsys only: downloads, hashes and .apkm extraction stay real.",
  },
  {
    icon: ShieldCheck,
    title: "Per-device tokens",
    body: "Every box authenticates with its own bearer token, stored as a sha256. Downloads are gated on it at the edge.",
  },
];

const flow = [
  { title: "agent", body: "Go binary on each box. Dials out, never listens." },
  { title: "hub", body: "Sockets, scheduler, source polling, cache-once." },
  { title: "edge", body: "Caddy. Streams the bundles off the volume." },
  { title: "web", body: "The dashboard you run rollouts from." },
];

const paths = [
  {
    href: "/docs/deployment/docker-compose",
    step: "01",
    label: "Get it running",
    body: "Clean VPS to a logged-in dashboard.",
  },
  {
    href: "/docs/deployment/coolify",
    step: "02",
    label: "Pick a deployment",
    body: "Caddy on one domain, or Coolify on two.",
  },
  {
    href: "/docs/fleet/agent",
    step: "03",
    label: "Flash a box",
    body: "Build the Magisk module with the hub URL.",
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      {/* Hero */}
      <section className="relative overflow-hidden">
        {/* One warm wash behind the fold. The accent is loud enough that this is
            the only place it covers area rather than drawing a line. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-40 h-[420px] opacity-15 bg-[radial-gradient(60%_60%_at_50%_50%,var(--color-fd-primary)_0%,transparent_70%)]"
        />
        <div className="relative mx-auto grid w-full max-w-6xl gap-12 px-6 py-20 md:py-28 lg:grid-cols-[1.15fr_1fr] lg:items-center">
          <div className="flex flex-col items-start gap-6">
            <span className="inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card/60 px-3 py-1 text-xs text-fd-muted-foreground">
              <Image src={logo} alt="" width={16} height={16} unoptimized priority />
              For fleets running Unown# and android devices
            </span>

            <h1 className="font-display text-4xl leading-[1.05] font-semibold tracking-tight text-balance md:text-6xl">
              Gotta magnet ’em all.
              <span className="text-fd-muted-foreground"> Seriously.</span>
            </h1>

            <p className="max-w-xl text-lg text-fd-muted-foreground">
              Magnemite watches for new Pokémon GO <code>.apkm</code> releases, caches them once on
              your server, and installs them across the fleet with per-device progress, automatic
              retries and canary rollouts.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/docs"
                className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-4 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
              >
                Read the docs <ArrowRight className="size-4" />
              </Link>
              <Link
                href="/docs/deployment/docker-compose"
                className="inline-flex items-center gap-2 rounded-lg border border-fd-border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
              >
                Get it running
              </Link>
            </div>
          </div>

          {/* Not a screenshot: the commands between a clean box and an enrolled
              one, which is the honest pitch. */}
          <div className="rounded-xl border border-fd-border bg-fd-card shadow-sm">
            <div className="flex items-center gap-2 border-b border-fd-border px-4 py-3">
              <span className="size-2.5 rounded-full bg-[#ff5f57]" />
              <span className="size-2.5 rounded-full bg-[#febc2e]" />
              <span className="size-2.5 rounded-full bg-[#28c840]" />
              <span className="ms-2 font-mono text-xs text-fd-muted-foreground">a whole fleet</span>
            </div>
            <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
              <code>
                <span className="text-fd-muted-foreground"># bring the stack up</span>
                {"\ndocker compose up -d --build\n\n"}
                <span className="text-fd-muted-foreground">
                  # optional: starter app target, sources, first token
                </span>
                {"\nmake seed\n\n"}
                <span className="text-fd-muted-foreground">
                  # bake the hub URL into a Magisk module
                </span>
                {"\nmake module SERVER="}
                <span className="text-fd-primary">https://agents.example.com</span>
                {"\n            TOKEN="}
                <span className="text-fd-primary">&lt;token&gt;</span>
                {"\n\n"}
                <span className="text-fd-muted-foreground">
                  # flash once — every later update rides the socket
                </span>
                {"\n./scripts/enroll.sh dist/agent.zip -f hosts.txt"}
              </code>
            </pre>
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="mx-auto w-full max-w-6xl px-6 pb-4">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-10 md:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label}>
              {/* A short accent tick instead of a divider: it groups the four
                  without drawing a band across the page. */}
              <span aria-hidden className="block h-0.5 w-7 rounded-full bg-fd-primary" />
              <dt className="font-display mt-4 text-3xl font-semibold tracking-tight md:text-4xl">
                {stat.value}
              </dt>
              <dd className="mt-1.5 font-mono text-[11px] tracking-wider text-fd-muted-foreground uppercase">
                {stat.label}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Features */}
      <section className="mx-auto w-full max-w-6xl px-6 py-16 md:py-20">
        <p className="font-mono text-xs tracking-wider text-fd-primary uppercase">Why it exists</p>
        <h2 className="font-display mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-balance md:text-4xl">
          Built for the day the rollout goes wrong
        </h2>
        {/* One line from lg up, where the column is wide enough for it; below
            that it wraps normally rather than overflowing. */}
        <p className="mt-3 text-lg text-fd-muted-foreground lg:whitespace-nowrap">
          Updating one box by hand is fine. The whole design is about the other hundred and
          ninety-nine.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="rounded-xl border border-fd-border bg-fd-card/40 p-5 transition-colors hover:border-fd-primary/40"
            >
              <span className="inline-flex size-9 items-center justify-center rounded-lg bg-fd-primary/15 text-fd-primary">
                <Icon className="size-4" />
              </span>
              <h3 className="mt-3.5 font-medium">{title}</h3>
              <p className="mt-1.5 text-sm text-fd-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* The four processes */}
      <section>
        <div className="mx-auto w-full max-w-6xl px-6 py-16 md:py-20">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="font-mono text-xs tracking-wider text-fd-primary uppercase">
                Architecture
              </p>
              <h2 className="font-display mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Four processes, on purpose
              </h2>
              <p className="mt-3 max-w-2xl text-lg text-pretty text-fd-muted-foreground">
                Two hundred device sockets have to survive a dashboard rebuild, so the socket server
                is not the dashboard.
              </p>
            </div>
            <Link
              href="/docs/architecture"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-fd-primary hover:underline"
            >
              How this magnet works <ArrowRight className="size-4" />
            </Link>
          </div>

          <ol className="mt-8 grid gap-3 md:grid-cols-4">
            {flow.map((item, i) => (
              <li
                key={item.title}
                className="rounded-xl border border-fd-border bg-fd-background p-5"
              >
                <span className="font-mono text-xs text-fd-muted-foreground">0{i + 1}</span>
                <h3 className="mt-1 font-medium">{item.title}</h3>
                <p className="mt-1.5 text-sm text-fd-muted-foreground">{item.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Start here */}
      <section className="mx-auto w-full max-w-6xl px-6 py-16 md:py-20">
        <p className="font-mono text-xs tracking-wider text-fd-primary uppercase">Three steps</p>
        <h2 className="font-display mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
          Start here
        </h2>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {paths.map((path) => (
            <Link
              key={path.href}
              href={path.href}
              className="group rounded-xl border border-fd-border p-6 transition-colors hover:border-fd-primary/40 hover:bg-fd-accent/40"
            >
              <span className="font-mono text-xs text-fd-primary">{path.step}</span>
              <span className="mt-2 flex items-center justify-between font-medium">
                {path.label}
                <ArrowRight className="size-4 text-fd-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </span>
              <span className="mt-1.5 block text-sm text-fd-muted-foreground">{path.body}</span>
            </Link>
          ))}
        </div>
      </section>

      <footer className="mt-8">
        <div className="mx-auto w-full max-w-6xl px-6 pb-12">
          <div className="border-t border-fd-border pt-6" />
          <div className="flex flex-wrap items-center justify-between gap-4 font-mono text-xs text-fd-muted-foreground">
            <span>© {new Date().getFullYear()} Magnemite. All rights reserved.</span>
            <span className="flex gap-5">
              <Link href="/docs" className="hover:text-fd-foreground">
                Docs
              </Link>
              <Link href="/docs/operations/security" className="hover:text-fd-foreground">
                Security
              </Link>
              <a
                href="https://github.com/pokemaplx/magnemite"
                className="hover:text-fd-foreground"
              >
                GitHub
              </a>
            </span>
          </div>
        </div>
      </footer>
    </main>
  );
}
