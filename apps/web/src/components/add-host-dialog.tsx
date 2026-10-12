"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { bootstrapHost } from "@/actions/hosts";

/**
 * Adding a machine, from the moment its provider handed over SSH access.
 *
 * This is the one click. Everything the machine needs — Docker, the binder
 * module, swap, the agent, its own identity — the bootstrap installs, and the
 * instance count typed here is applied the moment it dials in.
 *
 * The credential is deliberately not remembered. It is sent with this one call,
 * used once, and dropped: a retry asks for it again. That is the whole reason
 * this feature needs no secret store, and it is worth saying on the form so
 * nobody goes looking for where it was saved.
 */
export function AddHostDialog({ defaultWorkers }: { defaultWorkers: number }) {
  const [open, setOpen] = useState(false);
  const [auth, setAuth] = useState<"password" | "key">("password");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(formData: FormData) {
    setError(null);
    const instances = Number(formData.get("instances") ?? 0);
    const workers = Number(formData.get("workers") ?? defaultWorkers);

    start(async () => {
      const result = await bootstrapHost({
        name: String(formData.get("name") ?? ""),
        host: String(formData.get("host") ?? ""),
        port: Number(formData.get("port") ?? 22) || 22,
        username: String(formData.get("username") ?? ""),
        password: auth === "password" ? String(formData.get("password") ?? "") : undefined,
        privateKey: auth === "key" ? String(formData.get("privateKey") ?? "") : undefined,
        passphrase:
          auth === "key" ? String(formData.get("passphrase") ?? "") || undefined : undefined,
        desiredInstances: Number.isInteger(instances) ? instances : 0,
        desiredWorkers: Number.isInteger(workers) && workers > 0 ? workers : null,
      });
      if (result.error) setError(result.error);
      else setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1.5 h-4 w-4" />
          Add machine
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <form action={submit}>
          <DialogHeader>
            <DialogTitle>Add a machine</DialogTitle>
            <DialogDescription>
              It installs Docker, the binder module and the agent, then enrolls itself and brings up
              the containers. Nothing listens on the machine afterwards — it dials out, like a box.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" placeholder="hel-01" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="host">Address</Label>
                <Input id="host" name="host" placeholder="203.0.113.10" required />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="username">SSH user</Label>
                <Input id="username" name="username" defaultValue="root" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="port">Port</Label>
                <Input id="port" name="port" defaultValue="22" inputMode="numeric" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="instances">Instances</Label>
                <Input id="instances" name="instances" defaultValue="0" inputMode="numeric" />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor={auth === "password" ? "password" : "privateKey"}>
                  {auth === "password" ? "Password" : "Private key"}
                </Label>
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline"
                  onClick={() => setAuth(auth === "password" ? "key" : "password")}
                >
                  {auth === "password" ? "use a key instead" : "use a password instead"}
                </button>
              </div>
              {auth === "password" ? (
                <Input id="password" name="password" type="password" autoComplete="off" required />
              ) : (
                <>
                  <textarea
                    id="privateKey"
                    name="privateKey"
                    required
                    rows={4}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    className="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
                  />
                  <Input
                    name="passphrase"
                    type="password"
                    autoComplete="off"
                    placeholder="passphrase, if the key has one"
                  />
                </>
              )}
              {/* Said on the form, because somebody will otherwise go looking
                  for where it was saved. */}
              <p className="text-xs text-muted-foreground">
                Used once to reach the machine and kept nowhere — not in the database, the log or
                the audit trail. A retry asks again.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="workers">Workers per instance</Label>
              <Input
                id="workers"
                name="workers"
                defaultValue={String(defaultWorkers)}
                inputMode="numeric"
                className="w-28"
              />
              <p className="text-xs text-muted-foreground">
                Leave instances at 0 to provision the machine without starting anything, and set the
                number once you can see what it reports.
              </p>
            </div>

            {error ? <p className="text-sm text-danger">{error}</p> : null}
          </div>

          <DialogFooter className="mt-6">
            <Button type="submit" disabled={pending}>
              {pending ? "Starting…" : "Provision"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
