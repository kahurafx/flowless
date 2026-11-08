import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import { plugin } from "./boundaries.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser, ecmaVersion: 2024, sourceType: "module" } });
const rule = plugin.rules["module-boundaries"];
const api = "/repo/packages/api/src";

tester.run("module-boundaries", rule, {
  valid: [
    { filename: `${api}/modules/billing/service.ts`, code: `import { x } from "./events";` },
    { filename: `${api}/modules/billing/service.ts`, code: `import { accounts } from "../accounts";` },
    { filename: `${api}/modules/billing/service.ts`, code: `import { accounts } from "../accounts/index";` },
    { filename: `${api}/modules/billing/router.ts`, code: `import { moduleProcedure, router } from "../../trpc";` },
    { filename: `${api}/modules/billing/router.ts`, code: `import type { tenantProcedure } from "../../trpc";` },
    { filename: `${api}/modules/billing/service.ts`, code: `import { invoice } from "@flowless/db/schema/billing";` },
    { filename: `${api}/kernel/consumers.ts`, code: `import { consumers } from "../modules/billing";` },
    { filename: `${api}/kernel/trpc-like.ts`, code: `import { tenantProcedure } from "../trpc";` },
    { filename: "/repo/packages/auth/src/auth.ts", code: `import * as schema from "@flowless/db/auth-schema";` },
    { filename: "/repo/apps/mobile/src/app/index.tsx", code: `import type { AppRouter } from "@flowless/api";` },
  ],
  invalid: [
    { filename: `${api}/modules/billing/service.ts`, code: `import { read } from "../accounts/service";`, errors: [{ messageId: "otherModule" }] },
    { filename: `${api}/modules/billing/service.ts`, code: `export { read } from "../accounts/service";`, errors: [{ messageId: "otherModule" }] },
    { filename: `${api}/modules/billing/service.ts`, code: `const m = import("../accounts/service");`, errors: [{ messageId: "otherModule" }] },
    { filename: `${api}/kernel/consumers.ts`, code: `import { c } from "../modules/billing/events";`, errors: [{ messageId: "otherModule" }] },
    { filename: `${api}/modules/billing/service.ts`, code: `import { account } from "@flowless/db/schema/accounts";`, errors: [{ messageId: "otherSchema" }] },
    { filename: `${api}/modules/billing/router.ts`, code: `import { router, tenantProcedure } from "../../trpc";`, errors: [{ messageId: "builder" }] },
    { filename: `${api}/kernel/audit.ts`, code: `import { user } from "@flowless/db/auth-schema";`, errors: [{ messageId: "authSchema" }] },
    { filename: "/repo/apps/web/src/data/x.ts", code: `import { member } from "@flowless/db/auth-schema";`, errors: [{ messageId: "authSchema" }] },
    { filename: "/repo/apps/mobile/src/app/index.tsx", code: `import { createCaller } from "@flowless/api";`, errors: [{ messageId: "mobileRuntime" }] },
  ],
});
