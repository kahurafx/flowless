"use client";

import { SearchIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { CustomerChooser } from "@/components/accounts/customer-chooser";
import { PlaceFields } from "@/components/accounts/place-fields";
import { FieldSelect } from "@/components/field-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AccountFormOptions } from "@/data/customers";
import { customerChoiceInput, customerChoiceProblem, emptyPlace, placeFromState, type CustomerChoice, type PlaceState } from "@/lib/account-forms";
import { createAccountAction, createCustomerAction, createServicePointAction, previewNumberAction, searchParentsAction } from "../actions";

interface Parent {
  id: string;
  number: string;
  customerName: string;
}

/**
 * Opens an account (C-01, C-02, C-07). Saving is up to three steps (customer, account, service
 * point); each remembers that it worked, so a retry after a failure continues instead of
 * creating the customer or account twice.
 */
export function NewAccountForm({ options }: { options: AccountFormOptions }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [customer, setCustomer] = useState<CustomerChoice>({ mode: "existing", customer: null });
  const [categoryId, setCategoryId] = useState("");
  const [parent, setParent] = useState<Parent | null>(null);
  const [numbering, setNumbering] = useState<"suffix" | "own">("suffix");
  const [membershipClass, setMembershipClass] = useState("");
  const [withPoint, setWithPoint] = useState(true);
  const [place, setPlace] = useState<PlaceState>(emptyPlace);
  const [error, setError] = useState<string | null>(null);
  // What has already been saved, so a retry carries on from there.
  const [saved, setSaved] = useState<{ customerId?: string; account?: { id: string; number: string } }>({});

  const [preview, setPreview] = useState<{ parentId: string | null; next: string | null }>({ parentId: null, next: options.nextNumber });
  const wantedParent = parent && numbering === "suffix" ? parent.id : null;
  useEffect(() => {
    if (wantedParent === null) return;
    let current = true;
    previewNumberAction(wantedParent).then((r) => current && setPreview({ parentId: wantedParent, next: r.error === null ? r.data.next : null }));
    return () => {
      current = false;
    };
  }, [wantedParent]);
  const numberShown = wantedParent === null ? options.nextNumber : preview.parentId === wantedParent ? preview.next : null;

  const placeProblem = withPoint ? placeFromState(place) : null;
  const problem = saved.customerId ? null : customerChoiceProblem(customer);
  const ready = problem === null && (placeProblem === null || placeProblem.ok);

  const submit = () =>
    startTransition(async () => {
      setError(null);
      let customerId = saved.customerId;
      if (!customerId) {
        const input = customerChoiceInput(customer);
        if (!input) return setError("Choose or enter the customer");
        if ("customerId" in input) customerId = input.customerId;
        else {
          const created = await createCustomerAction(input.newCustomer);
          if (created.error !== null) return setError(created.error);
          customerId = created.data;
        }
        setSaved((s) => ({ ...s, customerId }));
      }
      let account = saved.account;
      if (!account) {
        const created = await createAccountAction({
          customerId,
          ...(categoryId ? { categoryId } : {}),
          ...(parent ? { parentAccountId: parent.id, numbering, ...(membershipClass ? { membershipClass } : {}) } : {}),
        });
        if (created.error !== null) return setError(`${created.error}${customer.mode === "new" ? " The customer was saved; saving again will not repeat it." : ""}`);
        account = created.data;
        setSaved((s) => ({ ...s, account }));
      }
      if (withPoint) {
        if (placeProblem && !placeProblem.ok) return setError(placeProblem.problem);
        const point = await createServicePointAction({ accountId: account.id, ...(placeProblem?.ok ? placeProblem.value : { address: place.address }) });
        if (point.error !== null) return setError(`Account ${account.number} was opened, but its service point could not be added: ${point.error}`);
      }
      toast.success(`Account ${account.number} opened`);
      router.push(`/accounts/${encodeURIComponent(account.number)}`);
    });

  return (
    <form
      className="grid max-w-2xl gap-8"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <fieldset className="grid gap-3" disabled={Boolean(saved.customerId)}>
        <legend className="mb-1 text-base font-semibold">Customer</legend>
        <CustomerChooser idPrefix="acct" value={customer} onChange={setCustomer} />
      </fieldset>

      <fieldset className="grid gap-4" disabled={Boolean(saved.account)}>
        <legend className="mb-1 text-base font-semibold">Account</legend>
        {options.showCategory && (
          <div className="grid gap-2">
            <Label htmlFor="acct-category">Category</Label>
            <FieldSelect id="acct-category" value={categoryId} onChange={setCategoryId} options={options.categories.map((c) => ({ value: c.id, label: c.name }))} placeholder="Choose a category" none="No category yet" />
          </div>
        )}
        <ParentPicker parent={parent} onChange={setParent} />
        {parent && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="acct-numbering">Number</Label>
              <FieldSelect
                id="acct-numbering"
                value={numbering}
                onChange={(v) => setNumbering(v as "suffix" | "own")}
                options={[
                  { value: "suffix", label: `Parent's number plus a letter` },
                  { value: "own", label: "A number of its own" },
                ]}
                placeholder="Numbering"
              />
            </div>
            {options.classes.length > 0 && (
              <div className="grid gap-2">
                <Label htmlFor="acct-class">Membership class</Label>
                <FieldSelect id="acct-class" value={membershipClass} onChange={setMembershipClass} options={options.classes.map((c) => ({ value: c.key, label: c.label }))} placeholder="No class" none="No class" />
              </div>
            )}
          </div>
        )}
        <p className="rounded-lg bg-muted/60 p-3 text-sm" aria-live="polite">
          {saved.account ? (
            <>
              Opened as <span className="font-mono font-medium">{saved.account.number}</span>.
            </>
          ) : (
            <>
              Next number: <span className="font-mono font-medium">{numberShown ?? "…"}</span>
              <span className="text-muted-foreground"> (not reserved; another account may take it first)</span>
            </>
          )}
        </p>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-1 text-base font-semibold">Service point</legend>
        <div className="flex items-center gap-2">
          <Checkbox id="acct-with-point" checked={withPoint} onCheckedChange={(v) => setWithPoint(v === true)} />
          <Label htmlFor="acct-with-point" className="font-normal">
            Add the service point now
          </Label>
        </div>
        {withPoint && <PlaceFields idPrefix="acct" options={{ areas: options.areas, routes: options.routes }} value={place} onChange={setPlace} />}
      </fieldset>

      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || !ready}>
          {saved.account ? "Finish" : "Open account"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ParentPicker({ parent, onChange }: { parent: Parent | null; onChange: (p: Parent | null) => void }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ q: string; rows: Parent[] }>({ q: "", rows: [] });
  const q = query.trim();
  const latest = useRef(q);
  useEffect(() => {
    latest.current = q;
    if (q.length < 2 || parent) return;
    const timer = setTimeout(async () => {
      const result = await searchParentsAction(q);
      if (latest.current === q && result.error === null) setFound({ q, rows: result.data });
    }, 300);
    return () => clearTimeout(timer);
  }, [q, parent]);
  const rows = found.q === q ? found.rows : [];

  if (parent) {
    return (
      <div className="grid gap-2">
        <Label>Parent account</Label>
        <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
          <span>
            <span className="font-mono font-medium">{parent.number}</span> {parent.customerName}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
            <XIcon />
            Remove
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <Label htmlFor="acct-parent">Parent account (optional)</Label>
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input id="acct-parent" className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Make this a child account: search the parent by number or name" autoComplete="off" />
      </div>
      {rows.length > 0 && (
        <ul className="grid gap-1" aria-label="Matching accounts">
          {rows.map((a) => (
            <li key={a.id}>
              <button type="button" className="flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onChange({ id: a.id, number: a.number, customerName: a.customerName })}>
                <span className="font-medium">{a.customerName}</span>
                <span className="font-mono text-xs text-muted-foreground">{a.number}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
