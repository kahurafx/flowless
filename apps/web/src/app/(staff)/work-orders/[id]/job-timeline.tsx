"use client";

import { MapPinIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { JobPage } from "@/data/work-orders";
import { formatWhen } from "@/lib/dates";
import { formatPosition } from "@/lib/use-position";
import { commentOnJob } from "../actions";

const eventLabel: Record<string, string> = {
  create: "Raised",
  assign: "Assigned",
  cancel: "Cancelled",
  resume: "Resumed",
  hold: "Put on hold",
  complete: "Completed",
  submit: "Submitted for review",
  approve: "Approved",
  return: "Returned for fixes",
  finalize: "Finalized",
  log_link: "Network log linked",
  add_asset: "Asset added",
  change_set: "Network branch opened",
  capture: "Completion data recorded",
};

function detail(type: string, payload: unknown, nameOf: (id: string | null) => string): string | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);
  switch (type) {
    case "hold":
      return [text(p.reason), text(p.note)].filter(Boolean).join(": ") || null;
    case "assign":
      return `to ${p.to ? nameOf(p.to as string) : "nobody"}`;
    case "return":
    case "approve":
    case "complete":
    case "submit":
    case "finalize":
      return text(p.note);
    case "change_set":
      return text(p.branch);
    default:
      return null;
  }
}

/** What happened to the job, oldest first. Refused and stale attempts are kept and marked. */
export function JobHistory({ page }: { page: JobPage }) {
  const { history, people, locale, timeZone } = page;
  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? "someone";
  const events = history.filter((e) => e.type !== "comment");
  return (
    <ol className="grid gap-0" aria-label="History">
      {events.map((e) => {
        const extra = detail(e.type, e.payload, nameOf);
        return (
          <li key={e.id} className="relative grid gap-0.5 border-l pb-4 pl-4 last:pb-0">
            <span className="absolute top-1.5 -left-1 size-2 rounded-full bg-border" aria-hidden />
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {eventLabel[e.type] ?? e.type}
              {e.outcome === "rejected" && <Badge variant="destructive">Refused</Badge>}
              {e.outcome === "stale" && <Badge variant="warning">Out of date</Badge>}
              {e.outcome === "unchanged" && <Badge variant="outline">No change</Badge>}
            </p>
            {e.reason && <p className="text-sm text-destructive">{e.reason}</p>}
            {extra && <p className="text-sm text-muted-foreground">{extra}</p>}
            <p className="text-xs text-muted-foreground tabular">
              {e.actor ?? "The system"} · {formatWhen(e.occurredAt, locale, timeZone)}
              {e.position && (
                <span className="ml-2 inline-flex items-center gap-1">
                  <MapPinIcon className="size-3" aria-hidden />
                  {formatPosition(e.position)}
                </span>
              )}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

export function JobComments({ page }: { page: JobPage }) {
  const { job, comments, locale, timeZone } = page;
  const [body, setBody] = useState("");
  // Minted once per comment, so a double tap or a retry adds it once.
  const [id, setId] = useState(() => crypto.randomUUID());
  const [pending, startTransition] = useTransition();
  const send = () =>
    startTransition(async () => {
      const result = await commentOnJob({ id, workOrderId: job.id, body });
      if (result.error !== null) toast.error(result.error);
      else {
        setBody("");
        setId(crypto.randomUUID());
      }
    });
  return (
    <div className="grid gap-4">
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="grid gap-3" aria-label="Comments">
          {comments.map((c) => (
            <li key={c.id} className="grid gap-1 rounded-xl border bg-card p-3">
              <p className="text-xs text-muted-foreground tabular">
                <span className="font-medium text-foreground">{c.author}</span> · {formatWhen(c.createdAt, locale, timeZone)}
              </p>
              <p className="text-sm whitespace-pre-wrap">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Label htmlFor="job-comment">Add a comment</Label>
        <Textarea id="job-comment" value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={4000} />
        <Button type="submit" className="justify-self-start" disabled={pending || body.trim() === ""}>
          Comment
        </Button>
      </form>
    </div>
  );
}
