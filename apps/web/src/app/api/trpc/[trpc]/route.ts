import { createTrpcHandler } from "@flowless/api";
import { getDb } from "@/server/db";

const handler = createTrpcHandler({ getDb, endpoint: "/api/trpc" });

export { handler as GET, handler as POST };
