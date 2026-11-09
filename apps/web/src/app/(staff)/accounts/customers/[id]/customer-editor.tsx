"use client";

import { CONTACT_CHANNELS, CONTACT_KINDS, type ContactChannel, type ContactKind } from "@flowless/shared-types";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ActionDialog } from "@/components/action-dialog";
import { FieldSelect } from "@/components/field-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { CustomerContact } from "@/data/customers";
import type { CustomerDetail } from "@/data/accounts";
import { contactChannelLabel, contactKindLabel } from "@/lib/account-labels";
import { addContactAction, removeContactAction, updateCustomerAction, updateContactAction } from "../../actions";

/** Edits the identity fields (C-01). Only what changed is sent; an emptied optional field is cleared. */
export function EditCustomer({ customer }: { customer: CustomerDetail }) {
  const identityKey = customer.type === "person" ? "nationalId" : "registrationNumber";
  const was = { name: customer.name, identity: customer[identityKey] ?? "", language: customer.language ?? "", notes: customer.notes ?? "" };
  const [name, setName] = useState(was.name);
  const [identity, setIdentity] = useState(was.identity);
  const [language, setLanguage] = useState(was.language);
  const [notes, setNotes] = useState(was.notes);

  const patch = {
    ...(name.trim() !== was.name ? { name: name.trim() } : {}),
    ...(identity.trim() !== was.identity ? { [identityKey]: identity.trim() || null } : {}),
    ...(language.trim() !== was.language ? { language: language.trim() || null } : {}),
    ...(notes.trim() !== was.notes ? { notes: notes.trim() || null } : {}),
  };
  const changed = Object.keys(patch).length > 0;
  return (
    <ActionDialog
      label="Edit details"
      icon={<PencilIcon />}
      title="Edit customer"
      submitLabel="Save"
      success="Customer saved"
      canSubmit={changed && name.trim() !== ""}
      onOpen={() => {
        setName(was.name);
        setIdentity(was.identity);
        setLanguage(was.language);
        setNotes(was.notes);
      }}
      onSubmit={async () => ({ error: (await updateCustomerAction({ id: customer.id, patch })).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor="cust-name">Name</Label>
        <Input id="cust-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="cust-identity">{customer.type === "person" ? "National id" : "Registration number"}</Label>
          <Input id="cust-identity" value={identity} onChange={(e) => setIdentity(e.target.value)} maxLength={40} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cust-language">Language</Label>
          <Input id="cust-language" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en or sw" maxLength={12} />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="cust-notes">Notes</Label>
        <Textarea id="cust-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={4000} />
      </div>
    </ActionDialog>
  );
}

/** The customer's contacts with add, edit and remove (C-01). A placeholder is shown as "No phone". */
export function ContactsManager({ customerId, contacts, canEdit }: { customerId: string; contacts: readonly CustomerContact[]; canEdit: boolean }) {
  const [removing, setRemoving] = useState<string | null>(null);
  const remove = async (id: string) => {
    setRemoving(id);
    const result = await removeContactAction(id);
    setRemoving(null);
    if (result.error !== null) toast.error(result.error);
    else toast.success("Contact removed");
  };
  return (
    <section aria-labelledby="contacts" className="grid gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="contacts" className="text-base font-semibold">
          Contacts
        </h2>
        {canEdit && <ContactDialog customerId={customerId} />}
      </div>
      {contacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No contacts yet.</p>
      ) : (
        <ul className="grid gap-2">
          {contacts.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <span className="w-14 text-xs text-muted-foreground">{contactChannelLabel[c.channel]}</span>
                {c.isPlaceholder ? (
                  <>
                    <Badge variant="warning">No phone</Badge>
                    <span className="text-xs text-muted-foreground">placeholder {c.value} is kept but not used</span>
                  </>
                ) : (
                  <span className="tabular font-medium">{c.value}</span>
                )}
                <span className="text-xs text-muted-foreground">{contactKindLabel[c.kind]}</span>
                {c.isPrimary && <Badge variant="outline">Primary</Badge>}
              </span>
              {canEdit && (
                <span className="flex gap-1">
                  <ContactDialog customerId={customerId} contact={c} />
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${c.value}`} disabled={removing === c.id} onClick={() => remove(c.id)}>
                    <Trash2Icon />
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ContactDialog({ customerId, contact }: { customerId: string; contact?: CustomerContact }) {
  const [channel, setChannel] = useState<ContactChannel>(contact?.channel ?? "phone");
  const [value, setValue] = useState(contact?.value ?? "");
  const [kind, setKind] = useState<ContactKind>(contact?.kind ?? "personal");
  const [primary, setPrimary] = useState(contact?.isPrimary ?? false);
  const editing = Boolean(contact);
  return (
    <ActionDialog
      label={editing ? "" : "Add contact"}
      icon={editing ? <PencilIcon aria-label="Edit contact" /> : <PlusIcon />}
      variant={editing ? "ghost" : "outline"}
      className={editing ? "size-8 p-0" : undefined}
      title={editing ? "Edit contact" : "Add a contact"}
      submitLabel={editing ? "Save" : "Add"}
      success={editing ? "Contact saved" : "Contact added"}
      canSubmit={value.trim() !== ""}
      onOpen={() => {
        setChannel(contact?.channel ?? "phone");
        setValue(contact?.value ?? "");
        setKind(contact?.kind ?? "personal");
        setPrimary(contact?.isPrimary ?? false);
      }}
      onSubmit={async () =>
        contact
          ? { error: (await updateContactAction({ id: contact.id, patch: { value: value.trim(), kind, isPrimary: primary } })).error }
          : { error: (await addContactAction({ customerId, channel, value: value.trim(), kind, isPrimary: primary })).error }
      }
    >
      {!editing && (
        <div className="grid gap-2">
          <Label htmlFor="contact-channel">Channel</Label>
          <FieldSelect id="contact-channel" value={channel} onChange={(v) => setChannel(v as ContactChannel)} options={CONTACT_CHANNELS.map((c) => ({ value: c, label: contactChannelLabel[c] }))} placeholder="Channel" />
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="contact-value">{channel === "phone" ? "Phone number" : "Email address"}</Label>
        <Input id="contact-value" value={value} onChange={(e) => setValue(e.target.value)} inputMode={channel === "phone" ? "tel" : "email"} maxLength={200} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="contact-kind">Kind</Label>
        <FieldSelect id="contact-kind" value={kind} onChange={(v) => setKind(v as ContactKind)} options={CONTACT_KINDS.map((k) => ({ value: k, label: contactKindLabel[k] }))} placeholder="Kind" />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="contact-primary" checked={primary} onCheckedChange={(v) => setPrimary(v === true)} />
        <Label htmlFor="contact-primary" className="font-normal">
          Primary {contactChannelLabel[channel].toLowerCase()}
        </Label>
      </div>
    </ActionDialog>
  );
}
