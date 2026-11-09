"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { CommercialStatusBadge } from "@/components/status-badges";
import { Button } from "@/components/ui/button";
import type { DuplicateGroup } from "@/data/data-quality";
import { duplicateKeyText, duplicateMatchLabel } from "@/lib/data-quality-view";
import { loadDuplicatesAction } from "./actions";

type Cursor = { matchedOn: "national_id" | "registration_number" | "phone"; key: string };

/** Customers who share a phone number, national id or registration number, grouped by what they share, each linking to both customers. */
export function DuplicatesList({ initial, initialCursor }: { initial: DuplicateGroup[]; initialCursor: Cursor | null }) {
  const [groups, setGroups] = useState(initial);
  const [cursor, setCursor] = useState(initialCursor);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (groups.length === 0) return <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">No two customers share a phone number, national id or registration number.</p>;
  return (
    <div>
      <ul className="grid gap-3">
        {groups.map((g) => (
          <li key={`${g.matchedOn}:${g.key}`} className="rounded-xl border bg-card p-4">
            <p className="mb-2 text-sm">
              <span className="font-medium">{duplicateMatchLabel[g.matchedOn]}</span> <span className="tabular font-mono text-muted-foreground">{duplicateKeyText(g.matchedOn, g.key)}</span>
            </p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {g.customers.map((c) => (
                <li key={c.id} className="rounded-lg border p-3">
                  <Link href={`/accounts/customers/${c.id}`} className="font-medium text-primary hover:underline">
                    {c.name}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                    {c.accounts.length === 0 && <span className="text-muted-foreground">No accounts</span>}
                    {c.accounts.map((a) => (
                      <span key={a.id} className="inline-flex items-center gap-1">
                        <Link href={`/accounts/${encodeURIComponent(a.number)}`} className="font-mono hover:underline">
                          {a.number}
                        </Link>
                        <CommercialStatusBadge status={a.commercialStatus as Parameters<typeof CommercialStatusBadge>[0]["status"]} />
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {cursor && (
        <div className="mt-3 flex justify-end">
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await loadDuplicatesAction(cursor);
                if (result.error !== null) return setError(result.error);
                setGroups((current) => [...current, ...result.data.items]);
                setCursor(result.data.nextCursor);
              })
            }
          >
            {pending ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
