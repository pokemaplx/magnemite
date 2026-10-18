# Working on Magnemite

A fleet manager for rooted Android TV boxes: a Go agent on each box, a Node hub
holding their sockets, a Next dashboard, Postgres or MariaDB behind both. A box
can also be a Redroid container rather than hardware — same agent, same
protocol, started by Android's own `init` instead of Magisk
(`fleet/redroid.mdx`).

**The real documentation is in `apps/docs/content/docs/`** and it is good — read
it rather than re-deriving. `development/local.mdx` is the setup, and
`development/fake-fleet.mdx` covers testing without hardware.

This file is only the things that cost time and are written nowhere else.

---

## Never run two dev servers for `apps/web`

Both compile into the same `apps/web/.next`, and each one deletes the other's
output. The symptom is baffling: a route logs `✓ Compiled /settings` and then
`GET /settings 404`, with `ENOENT` on files under `.next/server/app/`.

Before starting one, check nothing else is already serving the web app (the
docs run the same Next, so one on :3002 shows up here too — that one is fine):

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'next@16' } |
  ForEach-Object { "$($_.ProcessId)  $((Get-NetTCPConnection -OwningProcess $_.ProcessId -State Listen -EA SilentlyContinue).LocalPort)" }
```

If `.next` is already corrupted, stop every web server, `rm -rf apps/web/.next`,
then start exactly one.

## Local setup

```sh
docker compose --env-file .env -f deploy/compose.yml up -d postgres
pnpm --filter @magnemite/db exec prisma migrate deploy
pnpm db:seed          # admin, app target + its sources, group, first token
pnpm dev              # web :3000 · hub :3001 · docs :3002
```

`pnpm db:seed` prints the enrollment token **once** — keep it, the fake fleet
needs it. Login comes from `.env` (`ADMIN_EMAIL` / `ADMIN_PASSWORD`).

The hub runs under `tsx watch`, so **every file save restarts it and drops all
device sockets**. Boxes reconnect over a few seconds. That alone explains most
"devices went offline" and "gaps in the metric charts" moments while developing.

## Fake fleet (Windows)

```powershell
./scripts/build-agent.ps1 -SkipModule
./scripts/fake-fleet.ps1 -Count 8 -Token <enrollment-token>
Get-Content .dev\fleet\pids.txt | ForEach-Object { Stop-Process -Id $_ -Force }
```

Three traps, all of which look like something else:

- **Stop the fleet before rebuilding.** Windows locks a running `.exe`, and the
  build fails with `permission denied` on `magnemite-agent-windows-amd64.exe`.
- **Agent logs go to stderr**, so `.dev/fleet/fake-NNN.log` is empty and
  everything is in **`.dev/fleet/fake-NNN.log.err`**.
- **`make` needs Git Bash**, not PowerShell — the Makefile shells out to `awk`
  and `pwd`. In Git Bash, docker volume paths need `MSYS_NO_PATHCONV=1`:

```sh
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/agent":/src -w /src \
  golang:1.23-alpine sh -c 'gofmt -l . && go vet ./... && go test ./...'
```

## Driving the app without a browser

The hub's `/internal/*` API takes `x-magnemite-secret: $HUB_INTERNAL_SECRET` and
is the fastest way to exercise a real flow — poll sources, cache a version,
start a rollout across the fake fleet, all with `curl`.

For the dashboard, log in with `POST /api/auth/sign-in/email` and keep the
cookie jar.

**Grepping rendered HTML misleads.** Most tables and forms are client
components, so their _labels_ live in the JS chunk and never appear in the SSR
output — only their props do, inside the flight payload. `"Add an app target"
not in the HTML` proves nothing. Grep for the prop values instead.

## Where settings live

Two homes, and the split matters:

- **`.env`** — what is needed to boot and connect: database, secrets, ports,
  URLs. Changes per environment.
- **Settings → Tuning** — what is tuned while running: concurrency, intervals,
  retention, heartbeat. Same everywhere, wants changing without a deploy.

Several values moved from the first to the second, and the old variables are
now **ignored in silence** — a leftover `AGENT_UPDATE_CONCURRENCY` or
`DEVICE_OFFLINE_TIMEOUT` in `.env` does nothing at all. That is the trap of
that migration.

The hub caches these in `apps/hub/src/services/hubSettings.ts` and is told to
drop the copy by `POST /internal/settings` when the dashboard saves. Nothing
polls. **A value changed straight in psql therefore needs a hub restart, or one
Save from the dashboard.** Do not add a cache anywhere else — the dashboard read
one once, and a stale copy made saved settings look like they reverted to the
defaults.

Three of them are coupled and the form enforces it:
`deviceOfflineTimeout ≥ 3 × heartbeat`, `metricsSampleSeconds ≥ heartbeat`.
Monitoring adds none — it used to, and `monitor.unreachableAlertSeconds` is
gone: `AGENT_OFFLINE` fires on `deviceOfflineTimeout` itself, and a rule that
wants to wait longer says so in its own `threshold`, which is per group. The
monitor pass is **not** a setting either — it runs once per heartbeat, because
a pass reads what the boxes last said and they say it once per beat. There is
one right answer, so there is nothing to configure.

The heartbeat is **not** the only setting that lives on the boxes any more. The
monitor spec — what to probe — rides the same `welcome`, so it too reaches a box
on its **next connection**. The hub pushes a fresh `welcome` to everything
connected when a rule is saved — and when a save changes the heartbeat, which
is the one Tuning knob that needs it, because the offline sweep moves to the
new timeout at once and a fleet still on the old beat would be marked offline.
That push is what makes both feel immediate; a box that is offline picks the
change up when it comes back.

Settings are groups in the one `Setting` table, by key prefix: the hub knobs
are unprefixed, then `monitor.`, `redroid.`, `notify.` (the channels and the
repeat window) and `notify.event.` (one list of channels per fleet event).
`getHubSettings` used to keep a row only when `typeof row.value === "number"`,
which silently dropped the first string setting anyone added — it now compares
against the default's type, and a list default against `Array.isArray`, so a
string, a boolean or a list survives. If you add a group, go through
`readGroup`.

## Fleet notifications fire on transitions

`apps/hub/src/services/fleetEvents.ts` announces rollouts, builds, machines and
agent updates, and each `announceX` is called exactly where a state changes —
never from something that re-reads a state. Two consequences that are easy to
undo by accident:

- **`recomputeRollout` writes the status with a compare-and-set**
  (`updateMany where status = <what it read>`). Turning it back into a plain
  `update` brings back the race where two jobs finishing together both
  complete the rollout, announce it twice and release its waiters twice.
- **Anything fed from a poll or a sweep keeps its own memory** — the source
  failure streak, the agent versions already announced, the join-install
  throttle. Hooking a new event onto a loop without one is a message per pass.

## Monitoring will reboot your fleet if you let it

`apps/hub/src/services/monitor.ts` runs shell commands and reboots on boxes in
someone's living room, so most of it is refusals rather than logic. Three that
are easy to break by accident:

- **Unknown is not a failure.** A `null` reading — old agent, probe out of
  budget, no Rotom match — must neither count nor reset. Returning `false` from
  `readSignal` where you meant `null` turns silence into a healthy report.
- **The startup grace exists because of `tsx watch`.** Every file save restarts
  the hub and drops every socket at once. Without the grace, editing this repo
  is indistinguishable from a fleet-wide outage, and the fleet gets rebooted.
- **`monitorRan` is what makes an empty reading readable.** An absent
  `foregroundPackage` means the launcher is up (a fault) _and_ means the agent
  never looked (leave it alone). Only the flag separates them.

Seeded rules are written disabled and only when the table is empty. Keep it
that way — an upgrade that starts rebooting boxes is the worst possible
version of this feature.

## Version sources

Feeds are rows in the database, not config. Two things surprise people:

- The UnownHash mirror needs its base URL set to
  `https://mirror.unownhash.com/apks/`. Without the suffix the index parses fine
  and every download 404s.
- A build listed by two feeds is stored **once**, attributed to the feed with
  the lowest `priority`. So a feed can be working perfectly and show zero
  versions, because the other one won every build. Check
  `Settings → Version sources` for what each feed actually listed.

## Checks

```sh
pnpm --filter @magnemite/web typecheck
pnpm --filter @magnemite/hub exec tsc --noEmit
npx prettier --write <files>
make agent-test        # Git Bash only
```

Prisma schema is **generated**: edit `packages/db/prisma/schema.base.prisma`,
never `schema.prisma`. Migrations must be written for both providers —
`prisma/migrations/` and `prisma/migrations-mysql/`.
