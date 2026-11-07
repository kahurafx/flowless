import { organizationClient, twoFactorClient, usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/** Browser client for /api/auth (same origin). Names itself for the audit log (K-06). */
export const authClient = createAuthClient({
  plugins: [organizationClient(), twoFactorClient(), usernameClient()],
  fetchOptions: { headers: { "x-flowless-client": "web" } },
});
