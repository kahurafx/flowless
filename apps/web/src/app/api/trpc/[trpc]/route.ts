import { createTrpcHandler } from "@flowless/api";
import { getCaller } from "@/server/auth";
import { getDb } from "@/server/db";

const handler = createTrpcHandler({ endpoint: "/api/trpc", getDb, getSession: getCaller });

export { handler as GET, handler as POST };
