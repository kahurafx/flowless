import type { ContactChannel, ContactKind, CustomerType } from "@flowless/shared-types";

/*
 * Form-to-input mappers for the Accounts screens. Pure, so the rules (blank means absent,
 * coordinates are a pair or nothing, a person has a national id and an organization a
 * registration number) are tested without a browser. The API validates again.
 */

export type Coordinates = { lat: number; lng: number };
export type CoordinateResult = { ok: true; value: Coordinates | null } | { ok: false; problem: string };

/** Latitude and longitude as typed: both blank is no location, both valid is a point, anything else is a problem. */
export function parseCoordinates(latText: string, lngText: string): CoordinateResult {
  const lat = latText.trim();
  const lng = lngText.trim();
  if (lat === "" && lng === "") return { ok: true, value: null };
  if (lat === "" || lng === "") return { ok: false, problem: "Enter both latitude and longitude, or neither" };
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return { ok: false, problem: "Latitude and longitude must be numbers" };
  if (la < -90 || la > 90) return { ok: false, problem: "Latitude is between -90 and 90" };
  if (ln < -180 || ln > 180) return { ok: false, problem: "Longitude is between -180 and 180" };
  return { ok: true, value: { lat: la, lng: ln } };
}

export interface ContactDraft {
  channel: ContactChannel;
  value: string;
  kind: ContactKind;
  isPrimary: boolean;
}

/** Contacts with a value, trimmed; blank rows are dropped. */
export function contactInputs(drafts: readonly ContactDraft[]): ContactDraft[] {
  return drafts.map((d) => ({ ...d, value: d.value.trim() })).filter((d) => d.value !== "");
}

export interface NewCustomerDraft {
  type: CustomerType;
  name: string;
  identity: string;
  language: string;
  notes: string;
  contacts: readonly ContactDraft[];
}

export interface NewCustomerInput {
  type: CustomerType;
  name: string;
  nationalId?: string;
  registrationNumber?: string;
  language?: string;
  notes?: string;
  contacts: ContactDraft[];
}

/** The identity number goes to the field its customer type has (C-01). */
export function newCustomerInput(draft: NewCustomerDraft): NewCustomerInput {
  const identity = draft.identity.trim();
  const language = draft.language.trim();
  const notes = draft.notes.trim();
  return {
    type: draft.type,
    name: draft.name.trim(),
    ...(identity ? (draft.type === "person" ? { nationalId: identity } : { registrationNumber: identity }) : {}),
    ...(language ? { language } : {}),
    ...(notes ? { notes } : {}),
    contacts: contactInputs(draft.contacts),
  };
}

/** The placement fields of a service point or application as the API takes them: blank ids are left out. */
export function placeInput(place: { address: string; schemeId?: string; zoneId?: string; dmaId?: string; routeId?: string }, coordinates: Coordinates | null) {
  return {
    address: place.address.trim(),
    ...(place.schemeId ? { schemeId: place.schemeId } : {}),
    ...(place.zoneId ? { zoneId: place.zoneId } : {}),
    ...(place.dmaId ? { dmaId: place.dmaId } : {}),
    ...(place.routeId ? { routeId: place.routeId } : {}),
    ...(coordinates ? { location: coordinates } : {}),
  };
}

/** Which hierarchy field an area belongs in: the API wants scheme, zone and DMA separately; a sub-zone goes in the zone field's place. */
export function areaField(level: "scheme" | "zone" | "sub_zone" | "dma"): "schemeId" | "zoneId" | "dmaId" {
  return level === "scheme" ? "schemeId" : level === "dma" ? "dmaId" : "zoneId";
}

/** Amount text ("1250.50") as minor units, or null when it is not a positive amount with at most two decimals. */
export function parseMinorUnits(text: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const minor = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  return minor > 0n ? minor : null;
}
