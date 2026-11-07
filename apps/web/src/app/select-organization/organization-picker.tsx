"use client";

import { ChevronRightIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { authClient } from "@/lib/auth-client";

export function OrganizationPicker({ organizations }: { organizations: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (organizations.length === 0) {
    return (
      <p className="rounded-xl border bg-card p-5 text-center text-sm text-muted-foreground">
        Your account is not a member of any organization yet. Ask an administrator to invite you.
      </p>
    );
  }

  const choose = (organizationId: string) =>
    startTransition(async () => {
      setError(null);
      const { error } = await authClient.organization.setActive({ organizationId });
      if (error) {
        setError("Could not open that organization. Try again.");
        return;
      }
      router.push("/");
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y overflow-hidden rounded-xl border bg-card" aria-busy={pending}>
        {organizations.map((org) => (
          <li key={org.id}>
            <button
              type="button"
              disabled={pending}
              onClick={() => choose(org.id)}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm font-medium transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none active:bg-accent disabled:opacity-60"
            >
              <span className="truncate">{org.name}</span>
              <ChevronRightIcon className="ml-auto size-4 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
