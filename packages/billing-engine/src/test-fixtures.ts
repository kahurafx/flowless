import {
  balance,
  billReading,
  correctPeriod,
  finalBill,
  newAccount,
  periodIndex,
  postPayment,
  voidDocument,
  type Account,
  type Band,
  type Doc,
  type Policy,
  type ReadingInput,
  type Result,
  type TariffVersion,
} from "./index";

/**
 * The reference tariff of requirements section 6, in minor units (cents). The rate above 300 units is
 * unknown (OQ-1): 240.00 is the same placeholder billing-engine.html uses.
 */
export const B1: Band[] = [
  { upTo: 6, rate: 8250n },
  { upTo: 20, rate: 9600n },
  { upTo: 50, rate: 11000n },
  { upTo: 100, rate: 13100n },
  { upTo: 300, rate: 17250n },
  { upTo: 1000, rate: 24000n },
  { upTo: null, rate: 24000n },
];
export const B2: Band[] = [{ upTo: 6, rate: 9500n }, ...B1.slice(1)];

export const TARIFFS: TariffVersion[] = [
  { id: "T1", from: "2000-01", standing: 15000n, bands: B1 },
  { id: "T2", from: "2026-10", standing: 15000n, bands: B2 },
];

export const P = periodIndex;

/** A mutable handle over the immutable engine, so a scenario reads like the html's. */
export class Sim {
  a: Account;
  constructor(
    policy: Partial<Policy> = {},
    public tariffs: TariffVersion[] = TARIFFS,
    status?: string,
  ) {
    this.a = newAccount({ policy, status });
    ALL.push(this);
  }
  private run(r: Result): Result {
    this.a = r.account;
    return r;
  }
  bill(period: string, input: ReadingInput = {}): Result {
    return this.run(billReading(this.a, this.tariffs, period, input));
  }
  /** The document of a billed result; fails the test when the bill was held. */
  doc(period: string, input: ReadingInput = {}): Doc {
    const r = this.bill(period, input);
    if (r.outcome.kind !== "billed") throw new Error(`expected a bill for ${period}, got ${JSON.stringify(r.outcome, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`);
    return r.outcome.doc;
  }
  held(period: string, input: ReadingInput = {}): string {
    const r = this.bill(period, input);
    if (r.outcome.kind !== "held") throw new Error(`expected a hold for ${period}, got ${r.outcome.kind}`);
    return r.outcome.exception.code;
  }
  void(id: number): Result {
    return this.run(voidDocument(this.a, id));
  }
  correct(period: string): Result {
    return this.run(correctPeriod(this.a, this.tariffs, period));
  }
  disconnect(period: string, dial: number, key: string, fee = 100000n): Result {
    return this.run(finalBill(this.a, this.tariffs, period, { dial, fee, key }));
  }
  pay(amount: bigint): void {
    this.a = postPayment(this.a, amount);
  }
  get balance(): bigint {
    return balance(this.a);
  }
}

/** Every Sim created so far, for the invariant sweep. */
export const ALL: Sim[] = [];
