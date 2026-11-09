"use client";

import { SUCCESSION_BASES, type SuccessionBasis } from "@flowless/shared-types";
import { ArrowRightLeftIcon, BanIcon, MapPinnedIcon, MoonIcon, PauseCircleIcon, PlayCircleIcon, PlugZapIcon, ReceiptTextIcon, SunIcon, UserPenIcon, WalletIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { CustomerChooser } from "@/components/accounts/customer-chooser";
import { PlaceFields } from "@/components/accounts/place-fields";
import { FieldSelect } from "@/components/field-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AccountPage } from "@/data/accounts";
import { customerChoiceInput, customerChoiceProblem, emptyPlace, placeFromState, type CustomerChoice, type PlaceState } from "@/lib/account-forms";
import { DISCONNECT_REASONS, successionBasisLabel, WRITE_OFF_REASONS } from "@/lib/account-labels";
import { lifecycleActionsFor, type LifecycleAction } from "@/lib/account-lifecycle";
import { changeNameAction, requestRelocationAction, requestWriteOffAction, runLifecycle, succeedAction } from "../actions";

/** A client-minted id, fresh for each opening of a dialog: a retried submit replays, a new attempt acts. */
function useMintedId() {
  const [id, setId] = useState(() => crypto.randomUUID());
  return [id, () => setId(crypto.randomUUID())] as const;
}

const outcome = (result: { error: string | null }) => ({ error: result.error });

/** Reason, and an optional note: every status change records both (C-03). */
function ReasonFields({ idPrefix, reason, setReason, note, setNote, label = "Reason" }: { idPrefix: string; reason: string; setReason: (v: string) => void; note: string; setNote: (v: string) => void; label?: string }) {
  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-reason`}>{label}</Label>
        <Textarea id={`${idPrefix}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-note`}>Note (optional)</Label>
        <Textarea id={`${idPrefix}-note`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
      </div>
    </>
  );
}

const SIMPLE = {
  mark_pending_payment: { label: "Mark pending payment", icon: <ReceiptTextIcon />, title: "Mark as pending payment", description: "The new-connection invoice is out and payment is awaited.", success: "Marked pending payment" },
  make_dormant: { label: "Make dormant", icon: <MoonIcon />, title: "Make this account dormant", description: "The account stays on file with its number and history. It can be reactivated.", success: "Account made dormant" },
  reactivate: { label: "Reactivate", icon: <SunIcon />, title: "Reactivate this account", description: "A dormant account becomes active again.", success: "Account reactivated" },
  reconnect_service: { label: "Reconnect service", icon: <PlayCircleIcon />, title: "Reconnect the service", description: "The service is connected again; the account's commercial status does not change.", success: "Service reconnected" },
} as const;

function SimpleCommand({ kind, accountId }: { kind: keyof typeof SIMPLE; accountId: string }) {
  const [id, mint] = useMintedId();
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const c = SIMPLE[kind];
  return (
    <ActionDialog
      label={c.label}
      icon={c.icon}
      title={c.title}
      description={c.description}
      submitLabel={c.label}
      success={c.success}
      onOpen={mint}
      canSubmit={reason.trim() !== ""}
      onSubmit={async () => outcome(await runLifecycle({ kind, id, accountId, reason: reason.trim(), ...(note.trim() ? { note: note.trim() } : {}) }))}
    >
      <ReasonFields idPrefix={kind} reason={reason} setReason={setReason} note={note} setNote={setNote} />
    </ActionDialog>
  );
}

const OTHER = "__other";

function Disconnect({ accountId }: { accountId: string }) {
  const [id, mint] = useMintedId();
  const [choice, setChoice] = useState<string>(DISCONNECT_REASONS[0]);
  const [other, setOther] = useState("");
  const [note, setNote] = useState("");
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
      onOpen={mint}
      canSubmit={reason !== ""}
      onSubmit={async () => outcome(await runLifecycle({ kind: "disconnect_service", id, accountId, reason, ...(note.trim() ? { note: note.trim() } : {}) }))}
    >
      <div className="grid gap-2">
        <Label htmlFor="disconnect-reason">Reason</Label>
        <FieldSelect id="disconnect-reason" value={choice} onChange={setChoice} options={[...DISCONNECT_REASONS.map((r) => ({ value: r, label: r })), { value: OTHER, label: "Other" }]} placeholder="Choose a reason" />
        {choice === OTHER && <Input value={other} onChange={(e) => setOther(e.target.value)} maxLength={500} aria-label="Other reason" placeholder="Say why" required />}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="disconnect-note">Note (optional)</Label>
        <Textarea id="disconnect-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
      </div>
    </ActionDialog>
  );
}

function Terminate({ page }: { page: AccountPage }) {
  const [id, mint] = useMintedId();
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
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
      onOpen={mint}
      canSubmit={reason.trim() !== "" && (noLedger || approvalId !== "")}
      onSubmit={async () =>
        outcome(
          await runLifecycle({
            kind: "terminate",
            id,
            accountId: page.account.id,
            reason: reason.trim(),
            ...(note.trim() ? { note: note.trim() } : {}),
            ...(approvalId ? { approvalId } : {}),
            ...(noLedger ? { acknowledgeNoLedger: true } : {}),
          }),
        )
      }
    >
      <ReasonFields idPrefix="terminate" reason={reason} setReason={setReason} note={note} setNote={setNote} />
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
  const [id, mint] = useMintedId();
  const isChild = page.account.parent !== null;
  const bases = SUCCESSION_BASES.filter((b) => b !== "full_membership" || isChild);
  const [basis, setBasis] = useState<SuccessionBasis>(bases[0] ?? "change_of_name");
  const [sameCustomer, setSameCustomer] = useState(true);
  const [customer, setCustomer] = useState<CustomerChoice>({ mode: "existing", customer: null });
  const [servicePoints, setServicePoints] = useState<"move" | "leave">("move");
  const [reason, setReason] = useState("");
  const chosen = customerChoiceInput(customer);
  return (
    <ActionDialog
      label="Succeed"
      icon={<ArrowRightLeftIcon />}
      title="Open a successor account"
      description="Creates a new account with its own number and makes this one dormant, pointing to it. The balance and the closing reading move once billing and metering exist."
      submitLabel="Create successor"
      success="Successor account opened"
      onOpen={mint}
      canSubmit={reason.trim() !== "" && (sameCustomer || customerChoiceProblem(customer) === null)}
      onSubmit={async () =>
        outcome(
          await succeedAction({
            id,
            accountId: page.account.id,
            basis,
            servicePoints,
            reason: reason.trim(),
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
      <div className="grid gap-2">
        <Label htmlFor="succeed-reason">Reason</Label>
        <Textarea id="succeed-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
      </div>
    </ActionDialog>
  );
}

function ChangeName({ page }: { page: AccountPage }) {
  const [id, mint] = useMintedId();
  const [customer, setCustomer] = useState<CustomerChoice>({ mode: "existing", customer: null });
  const [date, setDate] = useState(page.today);
  const [closing, setClosing] = useState("");
  const [reason, setReason] = useState("");
  const chosen = customerChoiceInput(customer);
  return (
    <ActionDialog
      label="Change of name"
      icon={<UserPenIcon />}
      title="Change the account holder"
      description="The account keeps its number. The new holder takes over from the date below; earlier periods stay with the previous holder."
      submitLabel="Change holder"
      success="Holder changed"
      onOpen={() => {
        mint();
        setDate(page.today);
      }}
      canSubmit={chosen !== null && date !== "" && reason.trim() !== ""}
      onSubmit={async () =>
        chosen === null
          ? { error: "Choose the new holder" }
          : outcome(
              await changeNameAction({
                id,
                accountId: page.account.id,
                effectiveDate: date,
                reason: reason.trim(),
                ...(closing.trim() ? { closingReadingRef: closing.trim() } : {}),
                ...chosen,
              }),
            )
      }
    >
      <CustomerChooser idPrefix="rename" value={customer} onChange={setCustomer} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="rename-date">Effective from</Label>
          <Input id="rename-date" type="date" value={date} max={page.today} onChange={(e) => setDate(e.target.value)} required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="rename-closing">Closing reading (optional)</Label>
          <Input id="rename-closing" value={closing} onChange={(e) => setClosing(e.target.value)} maxLength={100} placeholder="Reference or value" />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="rename-reason">Reason</Label>
        <Textarea id="rename-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
      </div>
    </ActionDialog>
  );
}

function StartRelocation({ page }: { page: AccountPage }) {
  const [id, mint] = useMintedId();
  const live = page.account.servicePoints.filter((s) => s.connectionStatus !== "DECOMMISSIONED");
  const [from, setFrom] = useState(live[0]?.id ?? "");
  const [place, setPlace] = useState<PlaceState>(emptyPlace);
  const [reason, setReason] = useState("");
  const parsed = placeFromState(place);
  return (
    <ActionDialog
      label="Start relocation"
      icon={<MapPinnedIcon />}
      title="Relocate a service point"
      description="Moves the connection to a new place. The account keeps its number and status."
      submitLabel="Request relocation"
      success="Relocation requested"
      onOpen={mint}
      canSubmit={from !== "" && parsed.ok && reason.trim() !== ""}
      onSubmit={async () =>
        !parsed.ok
          ? { error: parsed.problem }
          : outcome(await requestRelocationAction({ id, accountId: page.account.id, fromServicePointId: from, to: parsed.value, reason: reason.trim() }))
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
      <div className="grid gap-2">
        <Label htmlFor="relocate-reason">Reason</Label>
        <Textarea id="relocate-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
      </div>
    </ActionDialog>
  );
}

/**
 * The lifecycle actions the caller may take on this account (C-03, C-08 to C-11). Buttons are
 * wayfinding: the state machine and permissions are enforced by the procedures, and a refusal
 * shows in the dialog. Activation has its own panel.
 */
export function LifecycleActions({ page }: { page: AccountPage }) {
  const actions: LifecycleAction[] = lifecycleActionsFor(page.account, page.permissions).filter((a) => a !== "activate");
  if (actions.length === 0) return null;
  const has = (a: LifecycleAction) => actions.includes(a);
  const accountId = page.account.id;
  return (
    <div className="flex flex-wrap gap-2" aria-label="Account actions">
      {has("mark_pending_payment") && <SimpleCommand kind="mark_pending_payment" accountId={accountId} />}
      {has("make_dormant") && <SimpleCommand kind="make_dormant" accountId={accountId} />}
      {has("reactivate") && <SimpleCommand kind="reactivate" accountId={accountId} />}
      {has("disconnect_service") && <Disconnect accountId={accountId} />}
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
