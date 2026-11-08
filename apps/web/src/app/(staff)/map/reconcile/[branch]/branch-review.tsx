"use client";

import { GitMergeIcon, MapPinnedIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ActionDialog } from "@/components/action-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { BranchPreview } from "@/data/gis";
import { formatWhen } from "@/lib/dates";
import { discardBranch, postBranch } from "../actions";

type Resolutions = Record<string, Record<string, "branch" | "main">>;

const MODE_LABEL: Record<string, string> = {
  create: "New",
  "fast-forward": "Changed",
  merge: "Merged with later changes on the live network",
  delete: "Deleted",
  restore: "Restored",
};
const ENTITY_LABEL: Record<string, string> = { node: "Node", pipe: "Pipe", structure: "Structure", connection: "Connection", dma: "DMA" };

/** A stored value as people read it. */
function show(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value.replaceAll("_", " ");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toLocaleDateString();
  if (Array.isArray(value)) return value.every((p) => p && typeof p === "object" && "lat" in p) ? `${value.length} points` : value.length > 3 ? `${value.length} items` : JSON.stringify(value);
  if (typeof value === "object" && "lat" in value && "lng" in value) return `${Number(value.lat).toFixed(5)}, ${Number(value.lng).toFixed(5)}`;
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

export function BranchReview({ preview }: { preview: BranchPreview }) {
  const router = useRouter();
  const [resolutions, setResolutions] = useState<Resolutions>({});
  const [override, setOverride] = useState(false);
  const [pending, startTransition] = useTransition();
  const [problems, setProblems] = useState<string[]>([]);
  const { origin, entities, summary } = preview;
  const when = (d: Date) => formatWhen(d, preview.locale, preview.timeZone);

  const conflicts = entities.flatMap((e) => e.conflicts.map((c) => ({ entity: e, ...c })));
  const unresolved = conflicts.filter((c) => !resolutions[c.entity.id]?.[c.field]);
  const cancelled = origin?.status === "cancelled";
  const unfinished = origin !== null && origin.status !== "completed" && !cancelled;
  const blocked = summary.needPhoto > 0 || unresolved.length > 0 || cancelled || (unfinished && !override) || summary.writes === 0;

  const resolve = (entityId: string, field: string, side: "branch" | "main") =>
    setResolutions((r) => ({ ...r, [entityId]: { ...r[entityId], [field]: side } }));

  const post = () =>
    startTransition(async () => {
      setProblems([]);
      const result = await postBranch({ branch: preview.branch, token: preview.token, resolutions, override });
      if (result.error !== null) {
        setProblems([result.error]);
        return;
      }
      const outcome = result.data;
      if (outcome.status === "posted") {
        toast.success(`Posted: ${outcome.summary.created} new, ${outcome.summary.fastForwarded + outcome.summary.merged} changed, ${outcome.summary.deleted} deleted`);
        router.push("/map/reconcile");
      } else if (outcome.status === "conflicts") {
        setProblems(outcome.conflicts.map((c) => `${c.name} has changes that clash with the live network. Choose which side wins.`));
      } else if (outcome.status === "invalid") {
        setProblems(outcome.violations.map((v) => (typeof v === "string" ? v : JSON.stringify(v))));
      } else {
        setProblems([`${outcome.origin.ref} is not approved yet. Tick "post anyway" to post it regardless.`]);
      }
    });

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <p className="label-caps text-muted-foreground">Branch</p>
        <h1 className="font-mono text-xl font-semibold break-all sm:text-2xl">{preview.branch}</h1>
        {origin ? (
          <p className="text-sm">
            For{" "}
            <Link href={`/work-orders/${origin.id}`} className="font-medium hover:underline">
              <span className="font-mono text-xs">{origin.ref}</span> {origin.title}
            </Link>{" "}
            <Badge variant={origin.status === "completed" ? "success" : origin.status === "cancelled" ? "destructive" : "warning"} className="ml-1 capitalize">
              {origin.status.replace("_", " ")}
            </Badge>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Personal edits, not tied to a job.</p>
        )}
        <p className="text-sm text-muted-foreground">
          Edited by {preview.authors.join(", ") || "unknown"}
          {preview.lastEditAt && `, last on ${when(preview.lastEditAt)}`}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="outline" render={<Link href={`/map?branch=${encodeURIComponent(preview.branch)}${origin ? `&job=${origin.id}` : ""}`} />}>
            <MapPinnedIcon />
            View on the map
          </Button>
        </div>
      </header>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="What posting does">
        {[
          ["Will be written", summary.writes],
          ["Already live", summary.skipped],
          ["Conflicts", summary.conflicts],
          ["Photos missing", summary.needPhoto],
        ].map(([label, n]) => (
          <div key={label} className="rounded-xl border bg-card p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-2xl font-semibold tabular">{n}</dd>
          </div>
        ))}
      </dl>

      <section className="grid gap-3 rounded-xl border bg-card p-4">
        <h2 className="text-base font-semibold">Changes</h2>
        <ul className="grid gap-3">
          {entities.map((e) => (
            <li key={e.id} className="grid gap-1.5 border-b pb-3 last:border-0 last:pb-0">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{e.name}</span>
                <Badge variant="outline">{ENTITY_LABEL[e.entityType] ?? e.entityType}</Badge>
                {e.kind === "write" && <Badge variant="info">{MODE_LABEL[e.detail] ?? e.detail}</Badge>}
                {e.kind === "skip" && <Badge variant="secondary">Nothing to do: {e.detail.replaceAll("-", " ")}</Badge>}
                {e.kind === "conflict" && <Badge variant="destructive">Conflict</Badge>}
                {e.needsPhoto && <Badge variant="warning">Photo needed</Badge>}
              </p>
              {e.changes.length > 0 && (
                <ul className="grid gap-0.5 text-sm text-muted-foreground">
                  {/* A new asset lists what it has, not every empty field. */}
                  {e.changes.filter((c) => e.detail !== "create" || (c.to !== null && c.to !== undefined)).map((c) => (
                    <li key={c.field}>
                      <span className="text-foreground">{c.field.replace(/([A-Z])/g, " $1").toLowerCase()}</span>: {e.detail === "create" ? show(c.to) : `${show(c.from)} to ${show(c.to)}`}
                    </li>
                  ))}
                </ul>
              )}
              {e.conflicts.map((c) => (
                <div key={c.field} className="grid gap-2 rounded-lg bg-destructive/5 p-3 text-sm" role="group" aria-label={`Resolve ${c.field}`}>
                  <p>
                    <span className="font-medium">{c.field.replace(/([A-Z])/g, " $1").toLowerCase()}</span> was changed on both sides (it was {show(c.base)}).
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant={resolutions[e.id]?.[c.field] === "branch" ? "default" : "outline"} aria-pressed={resolutions[e.id]?.[c.field] === "branch"} onClick={() => resolve(e.id, c.field, "branch")}>
                      Keep the branch: {show(c.branch)}
                    </Button>
                    <Button variant={resolutions[e.id]?.[c.field] === "main" ? "default" : "outline"} aria-pressed={resolutions[e.id]?.[c.field] === "main"} onClick={() => resolve(e.id, c.field, "main")}>
                      Keep the live network: {show(c.main)}
                    </Button>
                  </div>
                </div>
              ))}
            </li>
          ))}
        </ul>
      </section>

      {unfinished && (
        <label className="flex items-start gap-2 rounded-xl bg-warning/12 p-3 text-sm text-warning">
          <Checkbox checked={override} onCheckedChange={(v) => setOverride(v === true)} className="mt-0.5" />
          {origin!.ref} is {origin!.status.replace("_", " ")}, not completed. Post anyway, without waiting for its approval.
        </label>
      )}
      {cancelled && <p className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{origin!.ref} was cancelled, so these changes can only be discarded.</p>}
      {summary.needPhoto > 0 && <p className="rounded-xl bg-warning/12 p-3 text-sm text-warning">{summary.needPhoto} new {summary.needPhoto === 1 ? "asset needs" : "assets need"} a photo before they can go live.</p>}
      {unresolved.length > 0 && <p className="rounded-xl bg-warning/12 p-3 text-sm text-warning">Choose a side for {unresolved.length} {unresolved.length === 1 ? "conflict" : "conflicts"} before posting.</p>}
      {problems.length > 0 && (
        <ul className="grid gap-1 rounded-xl bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <Button onClick={post} disabled={pending || blocked}>
          <GitMergeIcon />
          Post to the live network
        </Button>
        <Discard branch={preview.branch} />
      </div>
    </div>
  );
}

function Discard({ branch }: { branch: string }) {
  const router = useRouter();
  return (
    <ActionDialog
      label="Discard"
      icon={<Trash2Icon />}
      variant="destructive"
      title="Discard this branch"
      description="The proposed changes stop being anyone's view of the network. Their history is kept."
      submitLabel="Discard"
      success="Branch discarded"
      onSubmit={async () => {
        const result = await discardBranch(branch);
        if (result.error === null) router.push("/map/reconcile");
        return result;
      }}
    />
  );
}
