import type { Database } from "@flowless/db";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./root";

/**
 * A Fetch API handler for the app router, so apps never import @trpc/server.
 * `getDb` is called per request, letting the app create its pool lazily.
 */
export function createTrpcHandler(options: { getDb: () => Database; endpoint: string }) {
  return (req: Request) =>
    fetchRequestHandler({
      endpoint: options.endpoint,
      req,
      router: appRouter,
      // Phase 1 (K-03): resolve the session from the request via packages/auth.
      createContext: () => ({ db: options.getDb(), session: null }),
    });
}
