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
import { Select } from "@/components/ui/select";
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
export function AddHostDialog({
  defaultWorkers,
  groups,
}: {
  defaultWorkers: number;
  groups: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [auth, setAuth] = useState<"password" | "key">("password");
  /**
   * Controlled, because the group has to survive the dialog being reopened
   * after a failed run — a provisioning that fell over on the password should
   * not quietly lose the site the operator picked, and a retry that enrols
   * twelve boxes into `default` is not a small mistake to make twice.
   */
  const [groupId, setGroupId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(formData: FormData) {
    setError(null);
    const instances = Number(formData.get("instances") ?? 0);
    // Empty follows Settings, and is sent as null so it keeps following it.
    // Pre-filling the fleet's number here is what used to make every new
    // machine a copy of the setting as it stood the day it was added.
    const workersTyped = String(formData.get("workers") ?? "").trim();
    const workers = workersTyped === "" ? null : Number(workersTyped);

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
        desiredWorkers:
          workers !== null && Number.isInteger(workers) && workers > 0 ? workers : null,
        desiredGroupId: groupId || null,
        desiredNameTemplate: String(formData.get("nameTemplate") ?? "").trim() || null,
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
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="workers">Workers per instance</Label>
                  <Input
                    id="workers"
                    name="workers"
                    // What an empty field follows, rather than a value that
                    // would be saved as this machine's own.
                    placeholder={`${defaultWorkers}, from Settings`}
                    inputMode="numeric"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="group">Group</Label>
                  <Select
                    id="group"
                    aria-label="Group the new containers enrol into"
                    value={groupId}
                    onValueChange={setGroupId}
                    disabled={pending}
                    // Radix reads "" as *no value*, so this is what the closed
                    // field says while nothing is picked — not decoration.
                    placeholder="No group"
                    options={[
                      // Not labelled `default`. A group called that usually
                      // exists already, because enrolment creates it when a box
                      // arrives with nowhere to go — so naming the empty option
                      // after it put the word in the list twice, once for a real
                      // group and once for the absence of one.
                      { value: "", label: "No group" },
                      ...groups.map((group) => ({ value: group.id, label: group.name })),
                    ]}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nameTemplate">Name the containers</Label>
                <Input
                  id="nameTemplate"
                  name="nameTemplate"
                  className="font-mono text-xs"
                  placeholder="{host}-{index}"
                  maxLength={64}
                />
                {/* Here for the same reason the group is: the boxes enrol as
                    the containers come up, and a name chosen afterwards is a
                    rename of things that already exist. */}
                <p className="text-xs text-muted-foreground">
                  <code>{"{host}"}</code>, <code>{"{index}"}</code> and <code>{"{serial}"}</code>.
                  Empty uses what the box reports about itself, which is the same manufacturer and
                  model on every box in the fleet — so they differ only in six characters of serial.
                </p>
              </div>

              <p className="text-xs text-muted-foreground">
                Leave instances at 0 to provision the machine without starting anything, and set the
                number once you can see what it reports.
              </p>
              {/* Here rather than on the machine's page, because there is no
                  moment in between: provisioning ends by starting the
                  containers and their boxes enrol as they come up. Chosen
                  afterwards, the first batch is already in `default` and has
                  already been handed that group's MITM config. */}
              <p className="text-xs text-muted-foreground">
                The group decides which MITM config its boxes are given, and they enrol the moment
                the containers come up — so it is chosen now rather than after. It can be changed on
                the machine&apos;s page, but that only affects containers added later.{" "}
                <strong>No group</strong> is not a third state: those boxes land in the group called{" "}
                <code>default</code>, which is created if it does not exist yet.
              </p>
            </div>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
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
