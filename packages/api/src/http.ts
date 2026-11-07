import type { AuditSource, Database } from "@flowless/db";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./root";
import type { Session } from "./trpc";

/**
 * A Fetch API handler for the app router, so apps never import @trpc/server.
 * `getDb` is called per request, letting the app create its pool lazily; `getSession`
 * resolves the Better Auth session from the request headers (K-03).
 */
export function createTrpcHandler(options: {
  endpoint: string;
  getDb: () => Database;
  getSession: (headers: Headers) => Promise<Session | null>;
}) {
  return (req: Request) =>
    fetchRequestHandler({
      endpoint: options.endpoint,
      req,
      router: appRouter,
      createContext: async () => ({
        db: options.getDb(),
        session: await options.getSession(req.headers),
        source: sourceOf(req.headers),
      }),
    });
}

/** Clients name themselves in `x-flowless-client`; anything else is a direct API call. */
function sourceOf(headers: Headers): AuditSource {
  const client = headers.get("x-flowless-client");
  return client === "web" || client === "mobile" ? client : "api";
}
