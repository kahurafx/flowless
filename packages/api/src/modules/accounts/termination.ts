/*
 * Termination rules (C-11), pure. An account may be terminated only from a settled position:
 * a final bill issued and a zero balance, or a balance written off by an approval (K-05) that
 * covers it. There is no ledger until Phase 4, so with no ledger registered the person
 * terminating says so explicitly. Whatever is decided is recorded in the command's payload.
 */

/** What the ledger says about an account (the termination port, `sources.ts`). */
export interface Position {
  finalBillIssued: boolean;
  /** Minor units owed by the customer: positive is owed to the utility, negative is a credit. */
  balance: bigint;
}

/** The approved write-off a termination cites, as the approval records it. */
export interface WriteOff {
  kind: string;
  subjectRef: string;
  status: string;
  amount: bigint | null;
}

export const WRITE_OFF_KIND = "accounts.write_off";

export type Settlement =
  | { ok: true; basis: "settled" | "written_off" | "no_ledger"; balance: bigint | null }
  | { ok: false; problem: string };

const refuse = (problem: string): Settlement => ({ ok: false, problem });

export function settleTermination(input: {
  accountId: string;
  /** null: no ledger is registered (or it has no answer yet). */
  position: Position | null;
  acknowledgeNoLedger: boolean;
  /** The write-off request the caller cites, if any, as found in the approvals. */
  writeOff: WriteOff | null;
  writeOffCited: boolean;
}): Settlement {
  const { position, writeOff } = input;
  if (position === null) {
    if (input.writeOffCited) return refuse("There is no ledger yet, so there is no balance to write off");
    if (!input.acknowledgeNoLedger) {
      return refuse("There is no ledger to check the balance against: confirm that the account has no balance owing to terminate it");
    }
    return { ok: true, basis: "no_ledger", balance: null };
  }
  if (!position.finalBillIssued) return refuse("Issue the final bill before terminating the account");
  if (position.balance === 0n) return { ok: true, basis: "settled", balance: 0n };
  if (position.balance < 0n) return refuse("The account is in credit: refund or transfer the credit before terminating it");
  if (!input.writeOffCited) {
    return refuse("The balance is not settled: collect it, or request a write-off and cite the approved request");
  }
  if (!writeOff) return refuse("That write-off request was not found");
  if (writeOff.kind !== WRITE_OFF_KIND || writeOff.subjectRef !== input.accountId) return refuse("That approval is not a write-off of this account");
  if (writeOff.status !== "approved") return refuse(`That write-off is ${writeOff.status}, not approved`);
  if (writeOff.amount === null || writeOff.amount < position.balance) {
    return refuse("The approved write-off does not cover the balance owing");
  }
  return { ok: true, basis: "written_off", balance: position.balance };
}
