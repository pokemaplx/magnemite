"use client";

import { useState, useTransition } from "react";
import { Play, Terminal } from "lucide-react";
import { execOnDevice } from "@/actions/devices";
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

type Result = { output: string; failed: boolean; message: string } | null;

export function DeviceExec({
  deviceId,
  name,
  open,
  onOpenChange,
}: {
  deviceId: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [command, setCommand] = useState("");
  const [result, setResult] = useState<Result>(null);
  const [pending, startTransition] = useTransition();

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
        if (!next) setResult(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[85vh] w-[min(48rem,95vw)] max-w-none flex-col gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-4 w-4" />
            Execute on {name}
          </DialogTitle>
          <DialogDescription>
            Runs through <code className="font-mono text-xs">sh -c</code> as root, the same way the
            install hooks do. Output is combined stdout and stderr, and the box gives up after 60
            seconds.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label>Suggestions</Label>
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((suggestion) => (
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
      </DialogContent>
    </Dialog>
  );
}
