import { expoClient } from "@better-auth/expo/client";
import type { AppRouter } from "@flowless/api";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createAuthClient } from "better-auth/client";
import { organizationClient, twoFactorClient, usernameClient } from "better-auth/client/plugins";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import superjson from "superjson";
import { MOBILE_APP_SCHEME } from "@flowless/shared-types";

/**
 * The only runtime link to the server. `AppRouter` is imported as a type: a value import from
 * `@flowless/api` would pull server code into the bundle (the lint rule `flowless/module-boundaries`
 * refuses it). The API is apps/web; locally that is port 3000 on the machine serving this bundle.
 */
const devHost = Constants.expoConfig?.hostUri?.split(":")[0];
export const API_URL = (process.env.EXPO_PUBLIC_API_URL || `http://${devHost ?? "localhost"}:3000`).replace(/\/$/, "");

/** Names this client in the audit log (K-06): sign-ins and every change show source "mobile". */
const CLIENT_HEADERS = { "x-flowless-client": "mobile" } as const;

export const authClient = createAuthClient({
  baseURL: API_URL,
  plugins: [
    expoClient({ scheme: MOBILE_APP_SCHEME, storagePrefix: "flowless", storage: SecureStore }),
    organizationClient(),
    twoFactorClient(),
    usernameClient(),
  ],
  fetchOptions: { headers: CLIENT_HEADERS },
});

export const api = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${API_URL}/api/trpc`,
      // superjson on the link (tRPC v11), the same transformer as the server: Dates and bigints survive.
      transformer: superjson,
      // The session is a cookie kept in secure storage; send it by hand and let fetch add none.
      headers: async () => ({ ...CLIENT_HEADERS, cookie: await authClient.getCookie() }),
      fetch: (url, options) => fetch(url, { ...options, credentials: "omit" }),
    }),
  ],
});

/** What a procedure answers, without importing the server's types: `Out<typeof api.gis.nodes.list.query>`. */
export type Out<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;
