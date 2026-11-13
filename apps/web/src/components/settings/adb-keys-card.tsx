"use client";

import { useState, useTransition } from "react";
import { Fingerprint } from "lucide-react";
import { adbKeys } from "@/actions/boxes";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The `adb_keys` file to preseed into a golden image.
 *
 * What it buys: adb over TCP shows "Allow USB debugging?" on the television
 * the first time an unknown key connects, and refuses everything until
 * somebody presses it. For one box that is a walk to the sofa; for a hundred
 * it is the difference between enrollment being automatic and not.
 *
 * Several keys, not one. The hub has its own and so does each machine,
 * because a key a box trusts is — with `su` — a root shell on that box, and a
 * relay in somebody's living room must not hold one that works fleet-wide.
 * The file is the format `/data/misc/adb/adb_keys` already wants: one public
 * key per line.
 *
 * Fetched on demand rather than rendered into the page: it reaches across to
 * the hub, and nobody opening Settings for an unrelated reason should pay for
 * that.
 */
export function AdbKeysCard() {
  const [keys, setKeys] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function load() {
    setError(null);
    start(async () => {
      const result = await adbKeys();
      if (result.error) setError(result.error);
      else setKeys(result.keys ?? "");
    });
  }

  const count = keys ? keys.split("\n").filter(Boolean).length : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Fingerprint className="h-4 w-4 text-muted-foreground" />
          adb keys
        </CardTitle>
        <CardDescription>
          Put these in <code>/data/misc/adb/adb_keys</code> in the image you flash and boxes trust
          Magnemite from first boot — no &ldquo;Allow USB debugging?&rdquo; on the television. One
          key for the hub, one for each machine that can enrol boxes on its LAN.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {keys === null ? (
          <div>
            <Button variant="outline" size="sm" onClick={load} disabled={pending}>
              {pending ? "Reading…" : "Show adb keys"}
            </Button>
          </div>
        ) : count === 0 ? (
          <p className="text-sm text-muted-foreground">
            No keys yet. The hub mints its own the first time it scans for boxes, and a machine
            mints its own the first time it is asked to relay one.
          </p>
        ) : (
          <>
            <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-subtle p-3 font-mono text-[10px] leading-relaxed break-all whitespace-pre-wrap">
              {keys}
            </pre>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void navigator.clipboard?.writeText(keys)}
              >
                Copy
              </Button>
              <span className="text-xs text-muted-foreground">
                {count} key{count === 1 ? "" : "s"} · one per line, which is the format the file
                wants
              </span>
            </div>
          </>
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {/* Said here because it is the one thing about this file that can bite
            somebody later: it is not a list to share around. */}
        <p className="text-xs text-muted-foreground">
          An adb key plus <code>su</code> is unrestricted root on a box that trusts it. Revoking one
          means editing <code>adb_keys</code> on the boxes themselves — there is no way to withdraw
          it from here.
        </p>
      </CardContent>
    </Card>
  );
}
