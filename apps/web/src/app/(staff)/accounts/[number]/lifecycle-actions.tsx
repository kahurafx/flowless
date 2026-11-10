"use client";

import { SUCCESSION_BASES, type SuccessionBasis } from "@flowless/shared-types";
import { ArrowRightLeftIcon, BanIcon, MapPinnedIcon, MoonIcon, PauseCircleIcon, PlayCircleIcon, PlugZapIcon, ReceiptTextIcon, SunIcon, UserPenIcon, WalletIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { CustomerChooser } from "@/components/accounts/customer-chooser";
import { PlaceFields } from "@/components/accounts/place-fields";
import { NoteField, ReasonField, ReasonFields, useReasonForm } from "@/components/accounts/reason-form";
import { FieldSelect } from "@/components/field-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AccountPage } from "@/data/accounts";
import { customerChoiceInput, customerChoiceProblem, emptyPlace, nextDay, placeFromState, type CustomerChoice, type PlaceState } from "@/lib/account-forms";
import { DISCONNECT_REASONS, successionBasisLabel, WRITE_OFF_REASONS } from "@/lib/account-labels";
import { lifecycleActionsFor, type LifecycleAction } from "@/lib/account-lifecycle";
import { optionalText } from "@/lib/optional-text";
import type { AccountOperations } from "@/data/billing-ops";
import { DisconnectWithBill, ReconnectWithCheck } from "./operations";
import { changeNameAction, requestRelocationAction, requestWriteOffAction, runLifecycle, succeedAction } from "../actions";

const outcome = (result: { error: string | null }) => ({ error: result.error });

const SIMPLE = {
  mark_pending_payment: { label: "Mark pending payment", icon: <ReceiptTextIcon />, title: "Mark as pending payment", description: "The new-connection invoice is out and payment is awaited.", success: "Marked pending payment" },
  make_dormant: { label: "Make dormant", icon: <MoonIcon />, title: "Make this account dormant", description: "The account stays on file with its number and history. It can be reactivated.", success: "Account made dormant" },
  reactivate: { label: "Reactivate", icon: <SunIcon />, title: "Reactivate this account", description: "A dormant account becomes active again.", success: "Account reactivated" },
  reconnect_service: { label: "Reconnect service", icon: <PlayCircleIcon />, title: "Reconnect the service", description: "The service is connected again; the account's commercial status does not change.", success: "Service reconnected" },
} as const;

function SimpleCommand({ kind, accountId }: { kind: keyof typeof SIMPLE; accountId: string }) {
  const form = useReasonForm();
  const c = SIMPLE[kind];
  return (
    <ActionDialog
      label={c.label}
      icon={c.icon}
      title={c.title}
      description={c.description}
      submitLabel={c.label}
      success={c.success}
      onOpen={form.mint}
      canSubmit={form.reason.trim() !== ""}
      onSubmit={async () => outcome(await runLifecycle({ kind, accountId, ...form.payload() }))}
    >
      <ReasonFields idPrefix={kind} form={form} />
    </ActionDialog>
  );
}

const OTHER = "__other";

function Disconnect({ accountId }: { accountId: string }) {
  const form = useReasonForm();
  const [choice, setChoice] = useState<string>(DISCONNECT_REASONS[0]);
  const [other, setOther] = useState("");
  const reason = choice === OTHER ? other.trim() : choice;
  return (
    <ActionDialog
      label="Disconnect service"
      icon={<PauseCircleIcon />}
      title="Disconnect the service"
      description="The customer's water is cut off. The account keeps its commercial status and can be reconnected."
      submitLabel="Disconnect"
      success="Service disconnected"
      variant="outline"
      onOpen={form.mint}
      canSubmit={reason !== ""}
      onSubmit={async () => outcome(await runLifecycle({ kind: "disconnect_service", accountId, ...form.payload(), reason }))}
    >
      <div className="grid gap-2">
        <Label htmlFor="disconnect-reason">Reason</Label>
        <FieldSelect id="disconnect-reason" value={choice} onChange={setChoice} options={[...DISCONNECT_REASONS.map((r) => ({ value: r, label: r })), { value: OTHER, label: "Other" }]} placeholder="Choose a reason" />
        {choice === OTHER && <Input value={other} onChange={(e) => setOther(e.target.value)} maxLength={500} aria-label="Other reason" placeholder="Say why" required />}
      </div>
      <NoteField idPrefix="disconnect" form={form} />
    </ActionDialog>
  );
}

function Terminate({ page }: { page: AccountPage }) {
  const form = useReasonForm();
  const [noLedger, setNoLedger] = useState(false);
  const [approvalId, setApprovalId] = useState("");
  const approved = page.writeOffs.filter((w) => w.status === "approved");
  return (
    <ActionDialog
      label="Terminate"
      icon={<BanIcon />}
      variant="destructive"
      title="Terminate this account"
      description="Termination is final: the account can never change status again. Its history stays."
      submitLabel="Terminate account"
      success="Account terminated"
      onOpen={form.mint}
      canSubmit={form.reason.trim() !== "" && (noLedger || approvalId !== "")}
      onSubmit={async () =>
        outcome(
          await runLifecycle({
            kind: "terminate",
            accountId: page.account.id,
            ...form.payload(),
            ...(approvalId ? { approvalId } : {}),
            ...(noLedger ? { acknowledgeNoLedger: true } : {}),
          }),
        )
      }
    >
      <ReasonFields idPrefix="terminate" form={form} />
      <div className="grid gap-3 rounded-xl border p-3">
        <p className="text-sm font-medium">Balance</p>
        <p className="text-sm text-muted-foreground">There is no ledger yet (billing arrives in a later phase), so Flowless cannot check what this account owes. Terminating means taking your word for it.</p>
        <div className="flex items-start gap-2">
          <Checkbox id="terminate-no-ledger" checked={noLedger} onCheckedChange={(v) => setNoLedger(v === true)} />
          <Label htmlFor="terminate-no-ledger" className="font-normal leading-snug">
            I confirm this account has no balance owing, and no ledger exists to check it against.
          </Label>
        </div>
        {approved.length > 0 && (
          <div className="grid gap-2">
            <Label htmlFor="terminate-writeoff">Or cite an approved write-off</Label>
            <FieldSelect id="terminate-writeoff" value={approvalId} onChange={setApprovalId} options={approved.map((w) => ({ value: w.id, label: `${w.reason ?? "Write-off"} · approved` }))} placeholder="No write-off" none="No write-off" />
          </div>
        )}
      </div>
    </ActionDialog>
  );
}

function WriteOff({ page }: { page: AccountPage }) {
  const [amount, setAmount] = useState("");
  const [code, setCode] = useState<string>(WRITE_OFF_REASONS[0].code);
  const [note, setNote] = useState("");
  return (
    <ActionDialog
      label="Request write-off"
      icon={<WalletIcon />}
      title="Request a write-off"
      description="A write-off needs approval from someone else (Approvals). Once approved it can be cited when terminating the account."
      submitLabel="Ask for approval"
      success="Write-off requested"
      canSubmit={amount.trim() !== "" && note.trim() !== ""}
      onSubmit={async () => outcome(await requestWriteOffAction({ accountId: page.account.id, amountText: amount, reasonCode: code, note: note.trim() }))}
    >
      <div className="grid gap-2">
        <Label htmlFor="writeoff-amount">Balance to write off ({page.currency})</Label>
        <Input id="writeoff-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="1250.00" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="writeoff-reason">Reason</Label>
        <FieldSelect id="writeoff-reason" value={code} onChange={setCode} options={WRITE_OFF_REASONS.map((r) => ({ value: r.code, label: r.label }))} placeholder="Choose a reason" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="writeoff-note">Note</Label>
        <Textarea id="writeoff-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} required />
      </div>
    </ActionDialog>
  );
}

function Succeed({ page }: { page: AccountPage }) {
  const form = useReasonForm();
  const isChild = page.account.parent !== null;
  const bases = SUCCESSION_BASES.filter((b) => b !== "full_membership" || isChild);
  const [basis, setBasis] = useState<SuccessionBasis>(bases[0] ?? "change_of_name");
  const [sameCustomer, setSameCustomer] = useState(true);
  const [customer, setCustomer] = useState<CustomerChoice>({ mode: "existing", customer: null });
  const [servicePoints, setServicePoints] = useState<"move" | "leave">("move");
  const chosen = customerChoiceInput(customer);
  return (
    <ActionDialog
      label="Succeed"
      icon={<ArrowRightLeftIcon />}
      title="Open a successor account"
      description="Creates a new account with its own number and makes this one dormant, pointing to it. The balance and the closing reading move once billing and metering exist."
      submitLabel="Create successor"
      success="Successor account opened"
      onOpen={form.mint}
      canSubmit={form.reason.trim() !== "" && (sameCustomer || customerChoiceProblem(customer) === null)}
      onSubmit={async () =>
        outcome(
          await succeedAction({
            id: form.id,
            accountId: page.account.id,
            basis,
            servicePoints,
            reason: form.reason.trim(),
            ...(sameCustomer ? {} : (chosen ?? {})),
          }),
        )
      }
    >
      <div className="grid gap-2">
        <Label htmlFor="succeed-basis">Why a successor</Label>
        <FieldSelect id="succeed-basis" value={basis} onChange={(v) => setBasis(v as SuccessionBasis)} options={bases.map((b) => ({ value: b, label: successionBasisLabel[b] }))} placeholder="Choose a basis" />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="succeed-same" checked={sameCustomer} onCheckedChange={(v) => setSameCustomer(v === true)} />
        <Label htmlFor="succeed-same" className="font-normal">
          Same customer holds the successor
        </Label>
      </div>
      {!sameCustomer && <CustomerChooser idPrefix="succeed" value={customer} onChange={setCustomer} />}
      <div className="grid gap-2">
        <Label htmlFor="succeed-sp">Service points</Label>
        <FieldSelect id="succeed-sp" value={servicePoints} onChange={(v) => setServicePoints(v as "move" | "leave")} options={[{ value: "move", label: "Move to the successor" }, { value: "leave", label: "Leave on this account" }]} placeholder="Choose" />
      </div>
      <ReasonField idPrefix="succeed" form={form} />
    </ActionDialog>
  );
}

function ChangeName({ page }: { page: AccountPage }) {
  const form = useReasonForm();
  const [customer, setCustomer] = useState<CustomerChoice>({ mode: "existing", customer: null });
  const [date, setDate] = useState(page.today);
  const [closing, setClosing] = useState("");
  const chosen = customerChoiceInput(customer);
  // The new holder takes over after the current one did, and not in the future.
  const current = page.holders.at(-1)?.validFrom;
  const earliest = current ? nextDay(current) : null;
  const tooSoon = earliest !== null && earliest > page.today;
  return (
    <ActionDialog
      label="Change of name"
      icon={<UserPenIcon />}
      title="Change the account holder"
      description={
        tooSoon
          ? `The current holder only took over on ${current}. A change of name can be dated from ${earliest}, so it has to wait until then.`
          : "The account keeps its number. The new holder takes over from the date below; earlier periods stay with the previous holder."
      }
      submitLabel="Change holder"
      success="Holder changed"
      onOpen={() => {
        form.mint();
        setDate(page.today);
      }}
      canSubmit={!tooSoon && chosen !== null && date !== "" && form.reason.trim() !== ""}
      onSubmit={async () =>
        chosen === null
          ? { error: "Choose the new holder" }
          : outcome(
              await changeNameAction({
                id: form.id,
                accountId: page.account.id,
                effectiveDate: date,
                reason: form.reason.trim(),
                ...optionalText("closingReadingRef", closing),
                ...chosen,
              }),
            )
      }
    >
      <CustomerChooser idPrefix="rename" value={customer} onChange={setCustomer} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="rename-date">Effective from</Label>
          <Input id="rename-date" type="date" value={date} max={page.today} {...(earliest ? { min: earliest } : {})} onChange={(e) => setDate(e.target.value)} required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="rename-closing">Closing reading (optional)</Label>
          <Input id="rename-closing" value={closing} onChange={(e) => setClosing(e.target.value)} maxLength={100} placeholder="Reference or value" />
        </div>
      </div>
      <ReasonField idPrefix="rename" form={form} />
    </ActionDialog>
  );
}

function StartRelocation({ page }: { page: AccountPage }) {
  const form = useReasonForm();
  const live = page.account.servicePoints.filter((s) => s.connectionStatus !== "DECOMMISSIONED");
  const [from, setFrom] = useState(live[0]?.id ?? "");
  const [place, setPlace] = useState<PlaceState>(emptyPlace);
  const parsed = placeFromState(place);
  return (
    <ActionDialog
      label="Start relocation"
      icon={<MapPinnedIcon />}
      title="Relocate a service point"
      description="Moves the connection to a new place. The account keeps its number and status."
      submitLabel="Request relocation"
      success="Relocation requested"
      onOpen={form.mint}
      canSubmit={from !== "" && parsed.ok && form.reason.trim() !== ""}
      onSubmit={async () =>
        !parsed.ok
          ? { error: parsed.problem }
          : outcome(await requestRelocationAction({ id: form.id, accountId: page.account.id, fromServicePointId: from, to: parsed.value, reason: form.reason.trim() }))
      }
    >
      {live.length > 1 && (
        <div className="grid gap-2">
          <Label htmlFor="relocate-from">Move which service point</Label>
          <FieldSelect id="relocate-from" value={from} onChange={setFrom} options={live.map((s) => ({ value: s.id, label: s.address }))} placeholder="Choose a service point" />
        </div>
      )}
      <p className="text-sm font-medium">New place</p>
      <PlaceFields idPrefix="relocate" options={page.placeOptions} value={place} onChange={setPlace} />
      <ReasonField idPrefix="relocate" form={form} />
    </ActionDialog>
  );
}

/**
 * The lifecycle actions the caller may take on this account (C-03, C-08 to C-11). Buttons are
 * wayfinding: the state machine and permissions are enforced by the procedures, and a refusal
 * shows in the dialog. Activation has its own panel.
 */
export function LifecycleActions({ page, ops }: { page: AccountPage; ops: AccountOperations | null }) {
  const actions: LifecycleAction[] = lifecycleActionsFor(page.account, page.permissions).filter((a) => a !== "activate");
  if (actions.length === 0) return null;
  const has = (a: LifecycleAction) => actions.includes(a);
  const accountId = page.account.id;
  return (
    <div className="flex flex-wrap gap-2" aria-label="Account actions">
      {has("mark_pending_payment") && <SimpleCommand kind="mark_pending_payment" accountId={accountId} />}
      {has("make_dormant") && <SimpleCommand kind="make_dormant" accountId={accountId} />}
      {has("reactivate") && <SimpleCommand kind="reactivate" accountId={accountId} />}
      {has("disconnect_service") && (ops?.canDisconnect ? <DisconnectWithBill accountId={accountId} ops={ops} /> : <Disconnect accountId={accountId} />)}
      {has("reconnect_service") && ops?.canDisconnect && <ReconnectWithCheck accountId={accountId} ops={ops} />}
      {has("reconnect_service") && <SimpleCommand kind="reconnect_service" accountId={accountId} />}
      {has("change_name") && <ChangeName page={page} />}
      {has("succeed") && <Succeed page={page} />}
      {has("relocate") && <StartRelocation page={page} />}
      {has("terminate") && <WriteOff page={page} />}
      {has("terminate") && <Terminate page={page} />}
      {page.writeOffs.some((w) => w.status === "pending") && (
        <Link href="/approvals?view=open" className="inline-flex items-center gap-1.5 self-center text-sm text-muted-foreground hover:underline">
          <PlugZapIcon className="size-4" />A write-off is waiting for approval
        </Link>
      )}
    </div>
  );
}
