"use client";

import { ClipboardListIcon, GitBranchIcon, GitMergeIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FieldSelect } from "@/components/field-select";
import { Badge } from "@/components/ui/badge";
import type { BranchChoice } from "@/data/gis";

/**
 * Which version of the network is on screen: the live one, a job's branch or a personal field
 * branch. Edits made here are proposals on that branch until someone with `gis:post` posts it.
 */
export function BranchBar({
  branch,
  choices,
  job,
  canPost,
  writable,
  why,
}: {
  branch: string;
  choices: BranchChoice[];
  job: { id: string; code: string; title: string; status: string; branch: string | null } | null;
  canPost: boolean;
  writable: boolean;
  /** Why this member cannot edit here, when they cannot. */
  why: string | null;
}) {
  const router = useRouter();
  const options = choices.map((c) => ({ value: c.branch, label: c.kind === "main" || c.kind === "mine" ? c.label : `${c.label} (${c.branch})` }));
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <GitBranchIcon className="size-4 text-muted-foreground" aria-hidden />
        <div className="w-full max-w-sm min-w-0 flex-1">
          <FieldSelect
            value={branch}
            onChange={(next) => router.push(next === "main" ? "/map" : `/map?branch=${encodeURIComponent(next)}${job && job.branch === next ? `&job=${job.id}` : ""}`)}
            options={options}
            placeholder="Choose a branch"
          />
        </div>
        {branch === "main" ? <Badge variant="success">Live</Badge> : <Badge variant="info">Proposal</Badge>}
        {job && (
          <Link href={`/work-orders/${job.id}`} className="inline-flex min-h-9 items-center gap-1.5 text-sm hover:underline">
            <ClipboardListIcon className="size-4" aria-hidden />
            <span className="font-mono text-xs">{job.code}</span> {job.title}
          </Link>
        )}
        {canPost && branch !== "main" && (
          <Link href={`/map/reconcile/${encodeURIComponent(branch)}`} className="inline-flex min-h-9 items-center gap-1.5 text-sm hover:underline">
            <GitMergeIcon className="size-4" aria-hidden />
            Review and post
          </Link>
        )}
      </div>
      {!writable && why && (
        <p className="text-sm text-muted-foreground" role="status">
          {why}
        </p>
      )}
    </div>
  );
}
