import { createTrpcHandler } from "@flowless/api";
import { getAuth } from "@/server/auth";
import { getDb } from "@/server/db";

const handler = createTrpcHandler({
  endpoint: "/api/trpc",
  getDb,
  getSession: (headers) => getAuth().api.getSession({ headers }),
});

export { handler as GET, handler as POST };
