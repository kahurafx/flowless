// Re-delivers an organization's processed events to one consumer with replay: true (K-09).
// pnpm --filter worker replay -- --consumer <name> --organization <id> [--since <ISO date>]
import { consumers, replayEvents } from "@flowless/api";
import { createDatabase } from "@flowless/db";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { consumer: { type: "string" }, organization: { type: "string" }, since: { type: "string" } },
});
const consumer = consumers.find((c) => c.name === values.consumer);
if (!consumer || !values.organization) {
  console.error(`Usage: replay --consumer <${consumers.map((c) => c.name).join(" | ")}> --organization <id> [--since <date>]`);
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must be set (see .env.example)");

const { db, close } = createDatabase(url, { max: 1 });
try {
  const since = values.since ? new Date(values.since) : undefined;
  const count = await replayEvents(db, consumer, { organizationId: values.organization, since });
  console.log(`Replayed ${count} event(s) to ${consumer.name}`);
} finally {
  await close();
}
