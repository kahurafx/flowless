/**
 * Input validation failures reach the client as a JSON array of issues (`[{"message":"Say why",...}]`).
 * Show the messages, not the JSON. Anything else is returned as it came.
 */
export function readableMessage(message: string): string {
  if (!message.trimStart().startsWith("[")) return message;
  try {
    const issues: unknown = JSON.parse(message);
    if (!Array.isArray(issues)) return message;
    const texts = issues.flatMap((i) => (i && typeof i === "object" && "message" in i && typeof i.message === "string" ? [i.message] : []));
    return texts.length > 0 ? [...new Set(texts)].join(". ") : message;
  } catch {
    return message;
  }
}
