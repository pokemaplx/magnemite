"use client";

import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
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
 * The "are you sure" for something destructive.
 *
 * `confirm()` was doing this job, and it is the wrong tool twice over: it
 * looks like the browser rather than the app, and it can only ask — it cannot
 * report that the answer was no. Deleting through a server action can fail for
 * a reason the person needs to read (a target still pinned by a rollout), so
 * this stays open and shows it rather than closing on a failure it never
 * mentioned.
 *
 * Deliberately dumb: the caller owns the transition and the error, because it
 * is the caller that knows what the action returned.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "Remove",
  pendingLabel = "Removing…",
  pending = false,
  disabled = false,
  error = null,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  /** Anything worth saying between the description and the buttons. */
  children?: ReactNode;
  confirmLabel?: string;
  pendingLabel?: string;
  pending?: boolean;
  /** Nothing to confirm — every box picked is offline, say. The children say why. */
  disabled?: boolean;
  error?: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {children}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending || disabled}
            onClick={onConfirm}
          >
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>

        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
