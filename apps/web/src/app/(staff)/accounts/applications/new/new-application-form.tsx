"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CustomerChooser } from "@/components/accounts/customer-chooser";
import { PlaceFields } from "@/components/accounts/place-fields";
import { FieldSelect } from "@/components/field-select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AccountFormOptions } from "@/data/customers";
import { customerChoiceInput, customerChoiceProblem, emptyPlace, placeFromState, type CustomerChoice, type PlaceState } from "@/lib/account-forms";
import { optionalText } from "@/lib/optional-text";
import { createApplicationAction } from "../actions";

/** Logs an enquiry (C-05). The id is minted once, so a retried submit cannot log it twice. */
export function NewApplicationForm({ options }: { options: AccountFormOptions }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [id] = useState(() => crypto.randomUUID());
  const [customer, setCustomer] = useState<CustomerChoice>({ mode: "existing", customer: null });
  const [categoryId, setCategoryId] = useState("");
  const [place, setPlace] = useState<PlaceState>(emptyPlace);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const placed = placeFromState(place);
  const ready = customerChoiceProblem(customer) === null && placed.ok;

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const who = customerChoiceInput(customer);
      if (!who || !placed.ok) return;
      const result = await createApplicationAction({
        id,
        ...who,
        ...placed.value,
        ...(categoryId ? { requestedCategoryId: categoryId } : {}),
        ...optionalText("notes", notes),
      });
      if (result.error !== null) return setError(result.error);
      toast.success("Enquiry logged");
      router.push(`/accounts/applications/${result.data}`);
    });

  return (
    <form
      className="grid max-w-2xl gap-8"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-base font-semibold">Customer</legend>
        <CustomerChooser idPrefix="app" value={customer} onChange={setCustomer} />
      </fieldset>
      <fieldset className="grid gap-4">
        <legend className="mb-1 text-base font-semibold">Connection wanted</legend>
        {options.showCategory && (
          <div className="grid gap-2">
            <Label htmlFor="app-category">Category</Label>
            <FieldSelect id="app-category" value={categoryId} onChange={setCategoryId} options={options.categories.map((c) => ({ value: c.id, label: c.name }))} placeholder="Choose a category" none="Not decided" />
          </div>
        )}
        <PlaceFields idPrefix="app" options={{ areas: options.areas, routes: options.routes }} value={place} onChange={setPlace} />
        <div className="grid gap-2">
          <Label htmlFor="app-notes">Notes (optional)</Label>
          <Textarea id="app-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={4000} />
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || !ready}>
          Log enquiry
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
