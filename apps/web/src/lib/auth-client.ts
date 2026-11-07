import { organizationClient, twoFactorClient, usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/** Browser client for /api/auth (same origin). */
export const authClient = createAuthClient({
  plugins: [organizationClient(), twoFactorClient(), usernameClient()],
});
