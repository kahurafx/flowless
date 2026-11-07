import { money, type AccountSummary, type StatementLine } from "@flowless/shared-types";
import { KILIMA, MAJI_SAFI } from "./tenants";

/** Account master data. The balance is not here: it is derived from `ledger` (I-2). */
export type MockAccount = Omit<AccountSummary, "balance"> & { org: string; openingMinor: bigint };

const kes = (amountMinor: bigint) => money(amountMinor, "KES");
const at = (iso: string) => new Date(iso);

export const accounts: readonly MockAccount[] = [
  {
    org: MAJI_SAFI, id: "acc-1008", number: "1008-4", customerName: "Grace Njeri Mutua",
    phone: "+254712345678", category: "Domestic", zone: "Kahawa West", route: "R-07",
    commercialStatus: "ACTIVE", service: { state: "CONNECTED" }, openingMinor: 0n,
  },
  {
    // Child account (C-02, C-07).
    org: MAJI_SAFI, id: "acc-1008b", number: "1008B-1", customerName: "Grace Njeri Mutua (Shop)",
    phone: "+254712345678", category: "Commercial", zone: "Kahawa West", route: "R-07",
    commercialStatus: "ACTIVE", service: { state: "CONNECTED" }, openingMinor: 0n,
  },
  {
    // Placeholder phone at import becomes no phone (C-01).
    org: MAJI_SAFI, id: "acc-1009", number: "1009-2", customerName: "St. Bakhita Girls' Secondary School Boarding Section",
    phone: null, category: "Institution", zone: "Githurai 45", route: "R-02",
    commercialStatus: "ACTIVE", service: { state: "CONNECTED" }, openingMinor: 1250000n,
  },
  {
    org: MAJI_SAFI, id: "acc-1010", number: "1010-8", customerName: "Ali Hassan",
    phone: "+254733000111", category: "Kiosk", zone: "Githurai 45", route: "R-02",
    commercialStatus: "ACTIVE", service: { state: "DISCONNECTED", reason: "Arrears over 90 days" }, openingMinor: 0n,
  },
  {
    org: MAJI_SAFI, id: "acc-1011", number: "1011-5", customerName: "Mwende",
    phone: "+254700222333", category: "Domestic", zone: "Kahawa Sukari", route: "R-11",
    commercialStatus: "PENDING_PAYMENT", service: { state: "DISCONNECTED", reason: "Not yet connected" }, openingMinor: 0n,
  },
  {
    org: MAJI_SAFI, id: "acc-1012", number: "1012-3", customerName: "Peter Kipchoge Langat",
    phone: "+254722444555", category: "Domestic", zone: "Kahawa Sukari", route: "R-11",
    commercialStatus: "DORMANT", service: { state: "DISCONNECTED", reason: "Successor account 1031-6" }, openingMinor: 0n,
  },
  {
    org: MAJI_SAFI, id: "acc-1031", number: "1031-6", customerName: "Faith Wairimu Langat",
    phone: "+254722444556", category: "Domestic", zone: "Kahawa Sukari", route: "R-11",
    commercialStatus: "ACTIVE", service: { state: "CONNECTED" }, openingMinor: 0n,
  },
  {
    org: MAJI_SAFI, id: "acc-1040", number: "1040-9", customerName: "Kahawa Farmers Cooperative Irrigation Scheme",
    phone: "+254711999888", category: "Farming", zone: "Kahawa West", route: "R-07",
    commercialStatus: "NEW", service: { state: "DISCONNECTED", reason: "Survey pending" }, openingMinor: 0n,
  },
  {
    org: KILIMA, id: "acc-b-201", number: "201-7", customerName: "Kilima Primary School",
    phone: "+254755123456", category: "Institution", zone: "Kilima Juu", route: "K-1",
    commercialStatus: "ACTIVE", service: { state: "CONNECTED" }, openingMinor: 0n,
  },
  {
    org: KILIMA, id: "acc-b-202", number: "202-4", customerName: "Mama Rehema Kiosk",
    phone: null, category: "Kiosk", zone: "Kilima Chini", route: "K-2",
    commercialStatus: "ACTIVE", service: { state: "CONNECTED" }, openingMinor: 0n,
  },
];

/**
 * Posted ledger lines per account. Append-only in spirit: corrections are their own lines.
 * acc-1008 reproduces requirements §6 scenario S-4: Oct estimate 480, Nov true-up −15 as a
 * credit note, Dec 232.50 (total 697.50 = 3 × 150 + 3 units × 82.50).
 */
export const ledger: Record<string, readonly StatementLine[]> = {
  "acc-1008": [
    { id: "l1", postedAt: at("2026-10-31T09:00:00Z"), type: "invoice", reference: "INV-26-10-0412", description: "October bill · estimated 4 units", amount: kes(48000n) },
    { id: "l2", postedAt: at("2026-11-04T12:30:00Z"), type: "payment", reference: "RCP-SKX81QZT2A", description: "M-Pesa payment", amount: kes(-48000n) },
    { id: "l3", postedAt: at("2026-11-30T09:00:00Z"), type: "credit_note", reference: "CN-26-11-0033", description: "November true-up: 2 units since actual 20 (165.00), less estimates already billed (−330.00), standing charge 150.00", amount: kes(-1500n) },
    { id: "l4", postedAt: at("2026-12-31T09:00:00Z"), type: "invoice", reference: "INV-26-12-0398", description: "December bill · actual 1 unit (82.50) + standing charge 150.00", amount: kes(23250n) },
  ],
  "acc-1008b": [
    { id: "l1", postedAt: at("2026-10-31T09:00:00Z"), type: "invoice", reference: "INV-26-10-0413", description: "October bill · actual 20 units", amount: kes(198900n) },
  ],
  "acc-1009": [
    { id: "l1", postedAt: at("2026-10-31T09:00:00Z"), type: "invoice", reference: "INV-26-10-0420", description: "October bill · actual 689 units", amount: kes(13979200n) },
    { id: "l2", postedAt: at("2026-11-10T08:00:00Z"), type: "payment", reference: "BNK-EQ-2026-118823", description: "Bank transfer (Equity)", amount: kes(-10000000n) },
  ],
  "acc-1010": [
    { id: "l1", postedAt: at("2026-08-31T09:00:00Z"), type: "invoice", reference: "INV-26-08-0201", description: "August bill · actual 31 units", amount: kes(319900n) },
    { id: "l2", postedAt: at("2026-09-15T09:00:00Z"), type: "invoice", reference: "INV-26-09-0007", description: "Disconnection fee", amount: kes(100000n) },
  ],
  "acc-1011": [
    { id: "l1", postedAt: at("2026-11-02T09:00:00Z"), type: "invoice", reference: "INV-NC-26-0019", description: "New connection: application, connection, meter, deposit", amount: kes(1250000n) },
    { id: "l2", postedAt: at("2026-11-03T09:00:00Z"), type: "payment", reference: "RCP-SKY2P0LM4C", description: "M-Pesa payment (deposit)", amount: kes(-500000n) },
  ],
  "acc-1012": [
    { id: "l1", postedAt: at("2026-09-30T09:00:00Z"), type: "invoice", reference: "INV-26-09-0310", description: "Final bill", amount: kes(64500n) },
    { id: "l2", postedAt: at("2026-10-01T09:00:00Z"), type: "transfer", reference: "TRF-26-0004", description: "Balance moved to successor 1031-6", amount: kes(-64500n), linkedLineId: "acc-1031:l1" },
  ],
  "acc-1031": [
    { id: "l1", postedAt: at("2026-10-01T09:00:00Z"), type: "transfer", reference: "TRF-26-0004", description: "Balance from predecessor 1012-3", amount: kes(64500n), linkedLineId: "acc-1012:l2" },
  ],
  "acc-b-201": [
    { id: "l1", postedAt: at("2026-10-31T09:00:00Z"), type: "invoice", reference: "KWP-INV-0091", description: "October bill · actual 54 units", amount: kes(581300n) },
  ],
  "acc-b-202": [],
};
