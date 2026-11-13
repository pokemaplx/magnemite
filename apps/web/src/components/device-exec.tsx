"use client";

import { useEffect, useState, useTransition } from "react";
import { ArrowLeft, FileJson, Play, RotateCcw, Terminal } from "lucide-react";
import { execOnDevice, previewDeviceConfig, pushDeviceConfig } from "@/actions/devices";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { DeviceConfigPreview, DeviceConfigPush } from "@/lib/hub";
import type { ExecMitm } from "@/lib/mitm-columns";

export type { ExecMitm };

/**
 * The commands this fleet actually needs, one click away.
 *
 * Scanner wrangling is the whole reason this dialog exists: stopping the app
 * before touching it and starting the mapping service again afterwards is what
 * people were opening adb for.
 */
const SUGGESTIONS: { label: string; command: string; hint: string }[] = [
  {
    label: "Stop Pokémon GO",
    command: "am force-stop com.nianticlabs.pokemongo",
    hint: "Kills the game. Rotom will restart it if the scanner is running.",
  },
  {
    label: "Stop Aegis",
    command: "am force-stop com.pokemod.aegis",
    hint: "Kills the scanner app itself.",
  },
  {
    label: "Start Aegis mapping",
    // Three commands, and each one is there because the shorter versions were
    // tried on a box and did not work.
    //
    //   monkey  takes the app out of the stopped state that `force-stop` --
    //           the suggestion right above this one -- put it in. Android
    //           delivers no intent to a stopped package, so without this the
    //           documented "stop it, then start the mapping" sequence could
    //           never have worked.
    //   sleep   because the service start lands before the app is up otherwise.
    //   start-foreground-service, not startservice: a plain `startservice`
    //           from the background is refused outright on Android 8 and later
    //           with "app is in background uid null".
    //
    // The foreground variant on its own exits 0 and starts nothing, which is
    // the worst of the three: a button that reports success and does not work.
    command:
      "monkey -p com.pokemod.aegis -c android.intent.category.LAUNCHER 1; sleep 3; " +
      "am start-foreground-service com.pokemod.aegis/com.pokemod.aegis.services.MappingService",
    hint: "After a stop. A box that has never run Aegis needs it started by hand once first.",
  },
  {
    label: "Grant Aegis root",
    // The same helper the agent runs after an install, by hand for the box no
    // install is going to touch: a rollout skips a box already on the target
    // version, and the grant rides the install. Only on a Redroid box -- on
    // hardware the file is not there and this says so.
    command: "/system/bin/magnemite-root-grant com.pokemod.aegis",
    hint: "Redroid only. Magisk keys root on the uid, and a reinstall changes it.",
  },
];

function getSuggestionsForMitm(
  mitm: ExecMitm | null,
): { label: string; command: string; hint: string }[] {
  const isLunala =
    mitm?.packageName === "org.cosmog.lunala" ||
    mitm?.packageName === "lunala" ||
    (mitm?.label && /lunala/i.test(mitm.label));
  const isDirect =
    mitm?.packageName === "com.pokemaplx.zoroark.direct" ||
    (mitm?.label && (/rpc/i.test(mitm.label) || /direct/i.test(mitm.label)));
  const isZoroark =
    mitm?.packageName === "com.pokemaplx.zoroark" || (mitm?.label && /zoroark/i.test(mitm.label));

  // After Lunala, whose package is `org.cosmog.lunala` and is a container
  // rather than a binary on the box.
  const isCosmog =
    !isLunala &&
    (mitm?.packageName === "com.sy1vi3.cosmog" ||
      mitm?.configPath?.endsWith("/cos/config.toml") ||
      (mitm?.label ? /cosmog/i.test(mitm.label) : false));

  if (isCosmog) {
    // Cosmog 2 is a binary named after the game, run from its own directory,
    // so none of the `am` commands apply. `[o]` stops pkill and pgrep matching
    // the shell that carries the pattern in its own command line.
    const dir = (mitm?.configPath ?? "/data/local/tmp/cos/config.toml").replace(/\/[^/]*$/, "");
    return [
      {
        label: "Stop Cosmog",
        command: "pkill -9 -f 'com\\.nianticlabs\\.pokemong[o]' || true",
        hint: "Kills the Cosmog binary and every worker under it.",
      },
      {
        label: "Start Cosmog",
        command: `cd ${shellQuote(dir)} && setsid nohup ./com.nianticlabs.pokemongo >/dev/null 2>&1 &`,
        hint: "After a stop. Detached, so it outlives this command.",
      },
      {
        label: "Is Cosmog running?",
        command: "pgrep -fl 'com\\.nianticlabs\\.pokemong[o]' || echo 'not running'",
        hint: "Lists the Cosmog processes, if any.",
      },
      {
        label: "Cosmog versions",
        command: `cd ${shellQuote(dir)} && echo "cosmog $(cat cos.version)"; echo "game $(cat pogo.version)"; ls -la . lib files`,
        hint: "What is unpacked there: the binary, libart.so, and the game's library and APKs.",
      },
      {
        label: "Tail Cosmog log",
        command: `tail -n 60 ${shellQuote(`${dir}/cosmog.log`)}`,
        hint: "Needs log_to_file = true in the config.",
      },
    ];
  }

  if (isLunala) {
    return [
      {
        label: "Restart Lunala",
        command: "docker restart lunala",
        hint: "Restarts the Lunala docker container.",
      },
      {
        label: "Tail Lunala logs",
        command: "docker logs --tail 60 lunala",
        hint: "Inspects the last 60 lines of container output.",
      },
      {
        label: "Check Lunala container",
        command: "docker ps --filter name=lunala",
        hint: "Checks whether the Lunala container is running.",
      },
    ];
  }

  if (isDirect) {
    return [
      {
        label: "Start RPC daemon",
        command:
          "cd /data/local/tmp/zoroark && nohup ./zoroarkd -config zoroark.json > zoroark.log 2>&1 &",
        hint: "Starts the standalone MITM daemon in RPC mode.",
      },
      {
        label: "Stop RPC daemon",
        command: "pkill -9 zoroarkd",
        hint: "Kills the running daemon process.",
      },
      {
        label: "Check RPC health",
        command: "curl -s http://127.0.0.1:9090/healthz || echo 'Health probe failed'",
        hint: "Checks the Prometheus HTTP health status on port 9090.",
      },
      {
        label: "Hot-reload config",
        command: "curl -s -X POST http://127.0.0.1:9090/-/reload",
        hint: "Reloads zoroark.json and dynamically resizes workers without restarting the process.",
      },
      {
        label: "Resize workers (+/-)",
        command: "curl -s -X POST 'http://127.0.0.1:9090/-/reload?workers=50'",
        hint: "Dynamically adjusts active worker count (e.g. ?workers=50) with zero downtime.",
      },
      {
        label: "Tail daemon logs",
        command: "tail -n 60 /data/local/tmp/zoroark/zoroark.log",
        hint: "Reads the last 60 lines of the daemon log.",
      },
    ];
  }

  if (isZoroark) {
    return [
      {
        label: "Stop Pokémon GO",
        command: "am force-stop com.nianticlabs.pokemongo",
        hint: "Kills the game process.",
      },
      {
        label: "Stop Zoroark",
        command: "am force-stop com.pokemaplx.zoroark; pkill -9 zoroarkd",
        hint: "Stops both the Zoroark companion app and the daemon.",
      },
      {
        label: "Start Zoroark Agent",
        command:
          "monkey -p com.pokemaplx.zoroark -c android.intent.category.LAUNCHER 1; sleep 2; " +
          "am start-foreground-service -a com.pokemaplx.zoroark.ACTION_START com.pokemaplx.zoroark/.service.ZoroarkService",
        hint: "Brings Zoroark to the foreground and starts the supervisor service.",
      },
      {
        label: "Restart Zoroark",
        command:
          "am start-foreground-service -a com.pokemaplx.zoroark.ACTION_RESTART com.pokemaplx.zoroark/.service.ZoroarkService",
        hint: "Triggers internal watchdog restart without relaunching app activity.",
      },
      {
        label: "Tail Zoroark logs",
        command: "tail -n 60 /data/local/tmp/zoroark/zoroark.log",
        hint: "Reads the last 60 lines of the daemon log.",
      },
    ];
  }

  return SUGGESTIONS;
}

type Result = { output: string; failed: boolean; message: string } | null;

/** Single quotes, with any in the value closed, escaped and reopened. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function DeviceExec({
  deviceId,
  name,
  open,
  onOpenChange,
  mitm,
}: {
  deviceId: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null when the box's group runs no MITM, or the box has no group. */
  mitm: ExecMitm | null;
}) {
  const [command, setCommand] = useState("");
  const [result, setResult] = useState<Result>(null);
  const [pending, startTransition] = useTransition();
  // Rewriting the config is a second view of this dialog rather than a dialog
  // of its own: it is reached from here, on a box somebody is already poking.
  const [view, setView] = useState<"command" | "config">("command");

  const configPath = mitm?.configPath ?? null;
  const mitmBaseSuggestions = getSuggestionsForMitm(mitm);
  // The group's own config, read where its MITM reads it -- first in the row,
  // because on a box whose scanner is misbehaving it is the first thing worth
  // looking at. Built from the group, so a Cosmog or Zoroark site gets its own path.
  const suggestions =
    mitm && configPath
      ? [
          {
            label: `Show ${mitm.label} config`,
            command: `cat ${shellQuote(configPath)}`,
            hint: "Prints the config file as it is on the box right now.",
          },
          ...mitmBaseSuggestions,
        ]
      : mitmBaseSuggestions;

  function run(toRun: string) {
    const trimmed = toRun.trim();
    if (!trimmed) return;
    setResult(null);
    startTransition(async () => {
      const outcome = await execOnDevice(deviceId, trimmed);
      setResult({
        output: outcome.output ?? "",
        failed: Boolean(outcome.error) || Boolean(outcome.failed),
        message: outcome.error ?? outcome.message ?? "",
      });
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setResult(null);
          setView("command");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex w-[min(48rem,calc(100%-2rem))] max-w-none flex-col gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {view === "config" ? (
              <FileJson className="h-4 w-4" />
            ) : (
              <Terminal className="h-4 w-4" />
            )}
            {view === "config" && mitm ? `${mitm.label} config on ${name}` : `Execute on ${name}`}
          </DialogTitle>
          <DialogDescription>
            {view === "config" ? (
              <>
                Written straight to the box, with nothing installed: the MITM is stopped, the file
                goes in the way an install writes it, and the MITM is started again on it.
              </>
            ) : (
              <>
                Runs through <code className="font-mono text-xs">sh -c</code> as root, the same way
                the install hooks do. Output is combined stdout and stderr, and the box gives up
                after 60 seconds.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {view === "config" && mitm && configPath ? (
          <ConfigRewrite
            deviceId={deviceId}
            name={name}
            mitm={mitm}
            configPath={configPath}
            onBack={() => setView("command")}
          />
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <Label>Suggestions</Label>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((suggestion) => (
                  <Button
                    key={suggestion.command}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    title={`${suggestion.command} — ${suggestion.hint}`}
                    onClick={() => setCommand(suggestion.command)}
                  >
                    {suggestion.label}
                  </Button>
                ))}
                {mitm && configPath ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    title="Writes a new config to this box and restarts the MITM on it, without reinstalling anything."
                    onClick={() => setView("config")}
                  >
                    <FileJson />
                    Rewrite {mitm.label} config…
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="device-command">Command</Label>
              <Textarea
                id="device-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="am force-stop com.nianticlabs.pokemongo"
                rows={3}
                className="font-mono text-xs"
                // Ctrl/Cmd+Enter runs it, because this is a box you are poking at
                // repeatedly, not a form you fill in once.
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run(command);
                }}
              />
            </div>

            {result ? (
              <div className="flex flex-col gap-1">
                <p
                  className={
                    result.failed ? "text-xs text-destructive" : "text-xs text-muted-foreground"
                  }
                >
                  {result.message}
                </p>
                <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-[11px] whitespace-pre-wrap">
                  {result.output || "(no output)"}
                </pre>
              </div>
            ) : null}

            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button disabled={pending || !command.trim()} onClick={() => run(command)}>
                <Play />
                {pending ? "Running…" : "Run"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The group's config, rendered for this box and editable before it is written.
 *
 * Read fresh every time the view opens: it is the group's template as it is
 * now, rendered against the box as it is now. An edit here goes to this box
 * alone -- the group keeps its own template.
 */
function ConfigRewrite({
  deviceId,
  name,
  mitm,
  configPath,
  onBack,
}: {
  deviceId: string;
  name: string;
  mitm: ExecMitm;
  configPath: string;
  onBack: () => void;
}) {
  const [preview, setPreview] = useState<DeviceConfigPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [outcome, setOutcome] = useState<{ push?: DeviceConfigPush; error?: string } | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    startTransition(async () => {
      const read = await previewDeviceConfig(deviceId);
      if (cancelled) return;
      if (read.error || !read.preview) {
        setLoadError(read.error ?? "Could not read the group's config.");
        return;
      }
      setPreview(read.preview);
      if (read.preview.state !== "none") setDraft(read.preview.content);
    });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  const ready = preview !== null && preview.state !== "none";

  function write() {
    if (!preview || preview.state === "none") return;
    // Untouched, the hub writes the group's template itself, which is the file
    // the next install would have written. Anything else is sent and rendered.
    const content = preview.state === "ready" && draft === preview.content ? null : draft;
    setOutcome(null);
    startTransition(async () => {
      const pushed = await pushDeviceConfig(deviceId, content);
      setOutcome(pushed.error ? { error: pushed.error } : { push: pushed.result });
    });
  }

  // Drawn the same before the config arrives as after it: the path is known
  // from the group already, and the editor stands at its full height, empty,
  // until the hub answers. A line of "reading…" in its place shrank the dialog
  // to that line and grew it back a moment later -- a flicker on every open.
  const loading = preview === null && loadError === null;

  return (
    <>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          Written to <span className="font-mono text-foreground">{configPath}</span>, rendered for{" "}
          {name} from its group&apos;s template. Change it here to write something else to this box
          alone — the group keeps its own.
        </p>

        {preview?.state === "refused" ? (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
            The group&apos;s template does not render on this box: {preview.reason}. Fix it below to
            write it anyway.
          </p>
        ) : null}

        <Textarea
          aria-label={`${mitm.label} config`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!ready}
          placeholder={
            loading
              ? "Reading the group's config…"
              : preview?.state === "none"
                ? "This box's group declares no config to write."
                : undefined
          }
          rows={12}
          spellCheck={false}
          className="font-mono text-xs"
        />

        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>
            Stops it first with{" "}
            <code className="font-mono text-foreground">
              {ready ? (preview.stop ?? "nothing") : "…"}
            </code>
          </span>
          <span>
            Starts it again with{" "}
            <code className="font-mono text-foreground">
              {ready ? (preview.start ?? "nothing") : "…"}
            </code>
          </span>
          <span>Those are the group&apos;s own install hooks, when it has them.</span>
        </div>

        {loadError ? <p className="text-xs text-destructive">{loadError}</p> : null}

        {ready && !preview.capable ? (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
            This box&apos;s agent is too old to rewrite a config on its own. It updates itself to
            one that can; until then the config goes on with the next install of {mitm.label}.
          </p>
        ) : null}

        {outcome?.error ? <p className="text-xs text-destructive">{outcome.error}</p> : null}
        {outcome?.push ? <PushResult push={outcome.push} label={mitm.label} /> : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" disabled={pending} onClick={onBack}>
          <ArrowLeft />
          Back
        </Button>
        <Button disabled={pending || !ready || !preview.capable || !draft.trim()} onClick={write}>
          <RotateCcw />
          {pending && ready ? "Writing…" : "Write and restart"}
        </Button>
      </DialogFooter>
    </>
  );
}

function PushResult({ push, label }: { push: DeviceConfigPush; label: string }) {
  if (!push.ok) {
    return (
      <p className="text-xs text-destructive">
        Not written: {push.error ?? "the box gave no reason"}
        {push.hookError ? ` — and ${push.hookError}` : ""}
      </p>
    );
  }
  const sum = push.sha256 ? ` (sha256 ${push.sha256.slice(0, 12)})` : "";
  if (push.hookError) {
    return (
      <p className="text-xs text-warning">
        Wrote {push.path}
        {sum}, but a hook failed — {push.hookError}. {label} may need starting by hand.
      </p>
    );
  }
  return (
    <p className="text-xs text-success">
      Wrote {push.path}
      {sum} and restarted {label}.
    </p>
  );
}
