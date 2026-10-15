"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Camera, RefreshCw } from "lucide-react";
import { captureScreenshot } from "@/actions/devices";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * What is actually on a box's screen.
 *
 * The reading this exists next to is `APP_NOT_FOREGROUND`, which says the
 * launcher owns the screen and cannot say what the launcher is showing. The
 * answers people are looking for here are all pictures: a login that expired,
 * a crash dialog, an update prompt, a Play Store page, a black screen.
 *
 * It captures on open and on the button, and never on a timer. A dashboard
 * taking pictures of somebody's television every few seconds is not this
 * feature — one capture, because a person asked for it, with their name on the
 * audit row.
 */
export function DeviceScreenshot({
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
  const [pending, startTransition] = useTransition();
  const [screenshotId, setScreenshotId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const capture = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const result = await captureScreenshot(deviceId);
      if (result.error || !result.screenshotId) {
        setError(result.error ?? "The box sent nothing back.");
        return;
      }
      setScreenshotId(result.screenshotId);
    });
  }, [deviceId]);

  // Opening the dialog is the request: nobody opens this to look at a picture
  // from an hour ago, and a button you have to press first would be a click
  // between you and the only thing on screen.
  useEffect(() => {
    if (!open) return;
    setScreenshotId(null);
    setError(null);
    capture();
  }, [open, capture]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{name}&rsquo;s screen</DialogTitle>
          <DialogDescription>
            One <code>screencap</code>, taken when you asked. Nothing is captured on a schedule.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-64 items-center justify-center rounded-md border border-border bg-subtle p-2">
          {error ? (
            <p className="max-w-prose px-4 py-8 text-center text-sm text-destructive">{error}</p>
          ) : screenshotId ? (
            // Keyed on the id so a second capture replaces the image rather
            // than the browser showing the cached first one — the route marks
            // these immutable, which is correct per id and wrong per element.
            <img
              key={screenshotId}
              src={`/api/devices/${deviceId}/screenshot/${screenshotId}`}
              alt={`The screen of ${name}`}
              className="max-h-[60vh] w-auto rounded"
            />
          ) : (
            <p className="px-4 py-8 text-sm text-muted-foreground">
              {pending ? "Asking the box…" : "Nothing captured yet."}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button variant="outline" disabled={pending} onClick={capture}>
            {screenshotId ? <RefreshCw /> : <Camera />}
            {pending ? "Capturing…" : screenshotId ? "Capture again" : "Capture"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
