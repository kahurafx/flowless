"use client";

import { CONTACT_CHANNELS, CONTACT_KINDS, CUSTOMER_TYPES } from "@flowless/shared-types";
import { AlertTriangleIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { findDuplicatesAction, searchCustomersAction } from "@/app/(staff)/accounts/actions";
import { FieldSelect } from "@/components/field-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { contactChannelLabel, contactKindLabel, customerTypeLabel } from "@/lib/account-labels";
import { emptyDraft, type ContactDraft, type CustomerChoice, type NewCustomerDraft } from "@/lib/account-forms";
import { cn } from "@/lib/utils";

interface Found {
  id: string;
  name: string;
  phone: string | null;
  nationalId: string | null;
  registrationNumber: string | null;
}

/** Debounced async value: runs `load` a moment after `key` stops changing and keeps only the newest answer. */
function useLookup<T>(key: string, enabled: boolean, load: () => Promise<T | null>): { key: string; value: T | null } {
  const [answer, setAnswer] = useState<{ key: string; value: T | null }>({ key: "", value: null });
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const timer = setTimeout(async () => {
      const value = await latest.current();
      if (current) setAnswer({ key, value });
    }, 350);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [key, enabled]);
  return answer;
}

/**
 * Pick a customer who exists, or enter a new one (C-01). A new customer whose phone or id
 * number matches someone already known gets a warning with the match to use instead; it is
 * a warning only, creating the duplicate is still allowed.
 */
export function CustomerChooser({
  idPrefix,
  value,
  onChange,
  allowNew = true,
}: {
  idPrefix: string;
  value: CustomerChoice;
  onChange: (next: CustomerChoice) => void;
  allowNew?: boolean;
}) {
  return (
    <div className="grid gap-3">
      {allowNew && (
        <div className="flex gap-2" role="radiogroup" aria-label="Customer">
          {(["existing", "new"] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              role="radio"
              aria-checked={value.mode === mode}
              variant={value.mode === mode ? "default" : "outline"}
              onClick={() => onChange(mode === "existing" ? { mode, customer: null } : { mode, draft: emptyDraft })}
            >
              {mode === "existing" ? "Existing customer" : "New customer"}
            </Button>
          ))}
        </div>
      )}
      {value.mode === "existing" ? (
        <ExistingCustomer idPrefix={idPrefix} chosen={value.customer} onChoose={(customer) => onChange({ mode: "existing", customer })} />
      ) : (
        <NewCustomer idPrefix={idPrefix} draft={value.draft} onChange={(draft) => onChange({ mode: "new", draft })} onUseExisting={(customer) => onChange({ mode: "existing", customer })} />
      )}
    </div>
  );
}

function ExistingCustomer({ idPrefix, chosen, onChoose }: { idPrefix: string; chosen: { id: string; name: string } | null; onChoose: (c: { id: string; name: string } | null) => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim();
  const found = useLookup<Found[]>(q, q.length >= 2 && !chosen, async () => {
    const result = await searchCustomersAction(q);
    return result.error === null ? result.data : null;
  });
  const results = found.key === q ? (found.value ?? []) : [];

  if (chosen) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
        <span className="font-medium">{chosen.name}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChoose(null)}>
          <XIcon />
          Change
        </Button>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <Label htmlFor={`${idPrefix}-customer-search`}>Find a customer</Label>
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input id={`${idPrefix}-customer-search`} className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, phone, email or id number" autoComplete="off" />
      </div>
      {q.length >= 2 &&
        (results.length === 0 ? (
          found.key === q && <p className="text-xs text-muted-foreground">No customer matches. Enter a new customer instead.</p>
        ) : (
          <ul className="grid gap-1" aria-label="Matching customers">
            {results.map((c) => (
              <li key={c.id}>
                <button type="button" className="flex w-full flex-col rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onChoose({ id: c.id, name: c.name })}>
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs text-muted-foreground">{[c.phone ?? "No phone", c.nationalId, c.registrationNumber].filter(Boolean).join(" · ")}</span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

function NewCustomer({
  idPrefix,
  draft,
  onChange,
  onUseExisting,
}: {
  idPrefix: string;
  draft: NewCustomerDraft;
  onChange: (next: NewCustomerDraft) => void;
  onUseExisting: (c: { id: string; name: string }) => void;
}) {
  const set = (patch: Partial<NewCustomerDraft>) => onChange({ ...draft, ...patch });
  const setContact = (index: number, patch: Partial<ContactDraft>) => set({ contacts: draft.contacts.map((c, i) => (i === index ? { ...c, ...patch } : c)) });

  // Duplicate warning (C-01): the first phone and the id number, checked as they are typed.
  const phone = draft.contacts.find((c) => c.channel === "phone" && c.value.trim().length >= 6)?.value.trim() ?? "";
  const identity = draft.identity.trim();
  const key = `${phone}|${identity}|${draft.type}`;
  const dupes = useLookup<Found[]>(key, phone !== "" || identity.length >= 3, async () => {
    const result = await findDuplicatesAction({
      ...(phone ? { phone } : {}),
      ...(identity.length >= 3 ? (draft.type === "person" ? { nationalId: identity } : { registrationNumber: identity }) : {}),
    });
    return result.error === null ? (result.data as unknown as Found[]) : null;
  });
  const matches = dupes.key === key ? (dupes.value ?? []) : [];

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-type`}>Type</Label>
          <FieldSelect id={`${idPrefix}-type`} value={draft.type} onChange={(v) => set({ type: v as NewCustomerDraft["type"] })} options={CUSTOMER_TYPES.map((t) => ({ value: t, label: customerTypeLabel[t] }))} placeholder="Type" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-name`}>Name</Label>
          <Input id={`${idPrefix}-name`} value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} required />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-identity`}>{draft.type === "person" ? "National id (optional)" : "Registration number (optional)"}</Label>
        <Input id={`${idPrefix}-identity`} value={draft.identity} onChange={(e) => set({ identity: e.target.value })} maxLength={40} />
      </div>

      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Contacts</legend>
        {draft.contacts.map((c, i) => (
          <div key={i} className="grid grid-cols-[6.5rem_1fr_7rem_auto] items-center gap-2">
            <FieldSelect value={c.channel} onChange={(v) => setContact(i, { channel: v as ContactDraft["channel"] })} options={CONTACT_CHANNELS.map((x) => ({ value: x, label: contactChannelLabel[x] }))} placeholder="Channel" />
            <Input value={c.value} onChange={(e) => setContact(i, { value: e.target.value })} placeholder={c.channel === "phone" ? "0712 345 678" : "name@example.com"} aria-label={`${contactChannelLabel[c.channel]} ${i + 1}`} inputMode={c.channel === "phone" ? "tel" : "email"} />
            <FieldSelect value={c.kind} onChange={(v) => setContact(i, { kind: v as ContactDraft["kind"] })} options={CONTACT_KINDS.map((x) => ({ value: x, label: contactKindLabel[x] }))} placeholder="Kind" />
            <Button type="button" variant="ghost" size="icon" aria-label="Remove contact" onClick={() => set({ contacts: draft.contacts.filter((_, j) => j !== i) })}>
              <XIcon />
            </Button>
          </div>
        ))}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => set({ contacts: [...draft.contacts, { channel: "phone", value: "", kind: "personal", isPrimary: false }] })}>
            <PlusIcon />
            Add a contact
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">A placeholder number such as 0000000000 is kept but counts as no phone (C-01).</p>
      </fieldset>

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-notes`}>Notes (optional)</Label>
        <Textarea id={`${idPrefix}-notes`} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} rows={2} maxLength={4000} />
      </div>

      {matches.length > 0 && (
        <div role="status" className={cn("grid gap-2 rounded-xl bg-warning/12 p-3 text-sm text-warning")}>
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangleIcon className="size-4" />
            This may be someone already known
          </p>
          <ul className="grid gap-1">
            {matches.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 text-foreground">
                <span>
                  <Link href={`/accounts/customers/${m.id}`} target="_blank" className="font-medium underline">
                    {m.name}
                  </Link>{" "}
                  <span className="text-xs text-muted-foreground">{[m.phone, m.nationalId, m.registrationNumber].filter(Boolean).join(" · ")}</span>
                </span>
                <Button type="button" size="sm" variant="outline" onClick={() => onUseExisting({ id: m.id, name: m.name })}>
                  Use this customer
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-xs">You can still create a new customer.</p>
        </div>
      )}
    </div>
  );
}
