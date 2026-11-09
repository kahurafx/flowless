import { optionalText } from "./optional-text";

/** What a status-changing dialog submits besides its own fields: the minted id, a trimmed reason and the note when there is one (C-03). */
export function reasonPayload(id: string, reason: string, note: string) {
  return { id, reason: reason.trim(), ...optionalText("note", note) };
}
