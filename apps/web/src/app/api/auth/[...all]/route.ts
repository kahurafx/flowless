import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth";

// Better Auth endpoints (sign-in, sessions, organizations, two-factor). Lazy, per request.
export const { GET, POST } = toNextJsHandler((request) => getAuth().handler(request));
