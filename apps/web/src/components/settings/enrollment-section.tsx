"use client";

import { useActionState, useState, useTransition } from "react";
import { KeyRound, Plus } from "lucide-react";
import { createEnrollmentToken, revokeEnrollmentToken } from "@/actions/settings";
import type { ActionState } from "@/actions/rollouts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { RelativeTime } from "@/components/relative-time";

export type TokenRow = {
  id: string;
  label: string;
  prefix: string;
  kind: "BOX" | "HOST";
  autoApprove: boolean;
  uses: number;
  maxUses: number | null;
  revoked: boolean;
  createdAt: string;
};

type TokenState = ActionState & { token?: string; kind?: "BOX" | "HOST" };

export function EnrollmentSection({
  tokens,
  publicUrl,
  disabled,
}: {
  tokens: TokenRow[];
  publicUrl: string;
  disabled: boolean;
}) {
  const [state, formAction] = useActionState<TokenState, FormData>(createEnrollmentToken, {});
  const [pending, startTransition] = useTransition();
  // Controlled only so the box can say what the tick means. Radix writes the
  // hidden `autoApprove` input either way, so the form posts the same.
  const [autoApprove, setAutoApprove] = useState(true);
  const [kind, setKind] = useState("BOX");
  const forHost = kind === "HOST";

  // The real token once there is one, so the commands below can be copied and
  // run. Before that they are still worth showing, with the placeholder the
  // docs use, because they say what the flags are called.
  const token = state.token ?? "<enrollment token>";

  const sample = `{
  "serverUrl": "${publicUrl}",
  "enrollmentToken": "${token}"
}`;

  // The same two flags in the two shells that can run the build. The Makefile
  // shells out to awk and pwd, so on Windows it wants Git Bash and the
  // PowerShell script is the way in — which is why both are here rather than
  // whichever one the reader's machine happens to want.
  //
  // Neither value is quoted, and a token starting with `-` is fine in both: a
  // base64url token needs no shell quoting, and PowerShell takes the word
  // after `-Token` as its value even when it looks like a parameter name.
  const buildCommands = `# Linux, macOS, Git Bash
make module SERVER=${publicUrl} TOKEN=${token}

# Windows PowerShell
./scripts/build-agent.ps1 -Server ${publicUrl} -Token ${token}`;

  // What to do with a *machine* token, which is a different artifact entirely:
  // no config.json, no module zip, just the environment the bootstrap reads.
  // Shown only after one is minted, because until then the box commands above
  // are the ones that apply -- and pasting a machine token into either of them
  // is a mistake nothing downstream catches.
  const mintedHost = state.kind === "HOST";
  const bootstrapCommand = `MAGNEMITE_SERVER=${publicUrl} \\
MAGNEMITE_TOKEN=${token} \\
MAGNEMITE_NAME=hel-01 \\
MAGNEMITE_SERIAL=<any stable, unique value> \\
sh ./bootstrap.sh`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          Enrollment tokens
        </CardTitle>
        <CardDescription>
          A new box — or a machine being provisioned by hand — presents one of these once and gets a
          token of its own back. Only the hash is stored, so a token is shown exactly one time.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {state.token ? (
          <div className="flex flex-col gap-2 rounded-md border border-success/40 bg-success/10 p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="h-4 w-4" />
              Copy this now (it is not shown again)
            </div>
            <code className="block break-all rounded bg-background p-2 font-mono text-xs">
              {state.token}
            </code>
          </div>
        ) : null}

        {mintedHost ? (
          <div className="flex flex-col gap-2">
            <Label>Give this to the bootstrap, on the machine</Label>
            <pre className="overflow-x-auto rounded-lg border border-border bg-subtle p-3 font-mono text-xs">
              {bootstrapCommand}
            </pre>
            <p className="text-xs text-muted-foreground">
              A machine token belongs to no box: it enrols one host, once. Only the manual path
              needs it — <strong>Machines → Add machine</strong> mints its own and nobody ever sees
              it. The serial is identity and must never change afterwards.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <Label>Put this on the box at /data/adb/magnemite/config.json</Label>
              <pre className="overflow-x-auto rounded-lg border border-border bg-subtle p-3 font-mono text-xs">
                {sample}
              </pre>
            </div>

            <div className="flex flex-col gap-2">
              <Label>Or bake it into the Magisk module zip, to flash a batch</Label>
              <pre className="overflow-x-auto rounded-lg border border-border bg-subtle p-3 font-mono text-xs">
                {buildCommands}
              </pre>
              <p className="text-xs text-muted-foreground">
                Either one writes that same config.json into the zip, so a flashed box enrols on its
                own with no further typing. Server and token go together: both refuse one without
                the other. Then flash the batch.
              </p>
            </div>
          </>
        )}

        {tokens.length > 0 ? (
          <Table containerClassName="lg:max-h-[24rem]">
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Enrols</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Uses</TableHead>
                <TableHead>Auto-approve</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((token) => (
                <TableRow key={token.id}>
                  <TableCell>
                    <span className={token.revoked ? "text-muted-foreground line-through" : ""}>
                      {token.label}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {token.kind === "HOST" ? "a machine" : "boxes"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{token.prefix}…</TableCell>
                  <TableCell className="font-mono text-xs">
                    {token.uses}
                    {token.maxUses ? ` / ${token.maxUses}` : ""}
                  </TableCell>
                  <TableCell>
                    {token.autoApprove ? (
                      <Badge variant="success">yes</Badge>
                    ) : (
                      <Badge variant="outline">manual</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <RelativeTime value={token.createdAt} />
                  </TableCell>
                  <TableCell className="text-right">
                    {!token.revoked && !disabled ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => startTransition(() => void revokeEnrollmentToken(token.id))}
                      >
                        Revoke
                      </Button>
                    ) : token.revoked ? (
                      <Badge variant="secondary">revoked</Badge>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}

        {!disabled ? (
          <form action={formAction} className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="token-label">Label</Label>
              <Input id="token-label" name="label" placeholder="batch-2" className="w-48" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="token-kind">Enrols</Label>
              <Select
                id="token-kind"
                name="kind"
                value={kind}
                onValueChange={setKind}
                className="w-40"
                options={[
                  { value: "BOX", label: "Boxes" },
                  { value: "HOST", label: "A machine" },
                ]}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="token-uses">Max uses</Label>
              <Input
                id="token-uses"
                name="maxUses"
                type="number"
                min={1}
                placeholder="unlimited"
                className="w-32"
              />
            </div>
            {/* Boxed and labelled from above like the two fields beside it: a
                bare checkbox sitting on the baseline had to be nudged down by
                hand to line up, and still read as an afterthought rather than
                the third thing a token decides. */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="token-auto-approve">Auto-approve devices</Label>
              <label
                htmlFor="token-auto-approve"
                className={
                  "flex h-9 items-center gap-2 rounded-lg border border-input bg-card px-3 text-sm " +
                  (forHost ? "opacity-40" : "cursor-pointer")
                }
              >
                <Checkbox
                  id="token-auto-approve"
                  name="autoApprove"
                  checked={forHost || autoApprove}
                  disabled={forHost}
                  onCheckedChange={(value) => setAutoApprove(value === true)}
                />
                <span className="text-muted-foreground">
                  {/* Not a choice on a machine, and saying so beats a tick
                      nobody can clear: /internal/authz refuses an unapproved
                      device, so a machine that enrolled pending would get a
                      bare 401 from the edge on its first self-update with
                      nothing anywhere to explain it. */}
                  {forHost
                    ? "Always, for a machine"
                    : autoApprove
                      ? "Joins the fleet"
                      : "Waits for review"}
                </span>
              </label>
            </div>
            <Button type="submit" variant="outline">
              <Plus />
              New token
            </Button>
            {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
