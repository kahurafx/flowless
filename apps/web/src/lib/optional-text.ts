/**
 * Optional text for an API input: `{ [key]: trimmed }` when the text has something in it, otherwise
 * nothing, so it spreads into an input without sending empty strings (`{ id, ...optionalText("note", note) }`).
 */
export function optionalText<K extends string>(key: K, value: string | null | undefined): Partial<Record<K, string>> {
  const text = value?.trim();
  return text ? ({ [key]: text } as Record<K, string>) : {};
}
