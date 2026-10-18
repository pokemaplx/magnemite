"use client";

import { Fragment } from "react";
import { useShortcuts, useShortcutsState } from "@/components/shortcuts/hotkeys";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import { SCOPES, SHORTCUT_IDS, primaryKey, shortcutDef } from "@/lib/shortcuts";

/**
 * Every shortcut there is, from the same list that binds them — so this can
 * only ever be out of date with the code by being out of date with itself.
 *
 * All of them, not just the ones bound on the page it was opened from: the
 * question it answers is usually "is there a key for that?", asked from
 * somewhere other than where the key works.
 */
export function ShortcutsDialog() {
  const { canOperate, setHelpOpen, setSingleKeys } = useShortcuts();
  const { helpOpen, singleKeys } = useShortcutsState();

  return (
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1">
            Single keys work anywhere outside a text field, and not while a dialog is open.
            <Kbd keys={primaryKey("palette")} /> works everywhere.
          </DialogDescription>
        </DialogHeader>

        <div className="gap-x-10 sm:columns-2">
          {SCOPES.map(({ scope, label, note }) => {
            const ids = SHORTCUT_IDS.filter((id) => {
              const def = shortcutDef(id);
              return def.scope === scope && (canOperate || !def.operator);
            });
            if (ids.length === 0) return null;

            return (
              <section key={scope} className="mb-6 break-inside-avoid">
                <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</h3>
                <dl className="text-sm">
                  {ids.map((id) => {
                    const def = shortcutDef(id);
                    return (
                      <div
                        key={id}
                        className="flex items-center justify-between gap-4 border-b border-border/60 py-1.5 last:border-0"
                      >
                        <dt className="min-w-0">{def.label}</dt>
                        <dd className="flex shrink-0 items-center gap-1.5">
                          {def.keys.map((keys, i) => (
                            <Fragment key={keys}>
                              {i > 0 ? (
                                <span className="text-xs text-muted-foreground">or</span>
                              ) : null}
                              <Kbd keys={keys} />
                            </Fragment>
                          ))}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
                {note ? <p className="mt-1.5 text-xs text-muted-foreground">{note}</p> : null}
              </section>
            );
          })}
        </div>

        {/* Single-letter keys are a hazard for anyone driving the page by voice
            or with a screen reader, where a stray letter is a stray command —
            so they can be turned off, and the chords stay. */}
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm">
          <Switch
            checked={singleKeys}
            onCheckedChange={setSingleKeys}
            className="mt-0.5"
            aria-label="Single-key shortcuts"
          />
          <span>
            Single-key shortcuts
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Every key above except <Kbd keys={primaryKey("palette")} className="align-middle" />.
              Turn them off if they get in the way of a screen reader or voice control. Remembered
              in this browser.
            </span>
          </span>
        </label>
      </DialogContent>
    </Dialog>
  );
}
