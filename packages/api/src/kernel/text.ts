/** A name or address as people type it: trimmed, inner runs of whitespace collapsed to one space. */
export const tidy = (text: string) => text.trim().replace(/\s+/g, " ");

/** Audit and event payloads are JSON: money (bigint) becomes a decimal string, dates ISO strings. */
export function plain<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
}
