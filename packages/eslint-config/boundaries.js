import path from "node:path";

/**
 * Module boundaries as lint rules (docs/build-plan.md → Boundary rules, NF-30). Paths are
 * matched on the file being linted, so the rule needs no project configuration.
 */
const MODULES = /\/packages\/api\/src\/modules\/([^/]+)(\/.*)?$/;
const KERNEL = /\/packages\/api\/src\/kernel\//;
const BUILDERS = new Set(["tenantProcedure", "permittedProcedure", "publicProcedure"]);

const posix = (p) => p.split(path.sep).join("/");
const isIndex = (rest) => !rest || /^\/index(\.ts)?$/.test(rest);

/** @type {import("eslint").Rule.RuleModule} */
const moduleBoundaries = {
  meta: {
    type: "problem",
    docs: { description: "Keep Flowless modules behind their published interfaces" },
    messages: {
      authSchema: "Only packages/auth may import @flowless/db/auth-schema. Learn about organizations through events.",
      otherModule: "Import the {{target}} module through its index.ts (its published interface), or use an event.",
      otherSchema: "A module touches only its own @flowless/db schema; {{target}} belongs to another module.",
      builder: "Module routers build procedures only from moduleProcedure(module), which checks the licence (K-04).",
      mobileRuntime: "apps/mobile may only `import type` from @flowless/api.",
    },
    schema: [],
  },
  create(context) {
    const file = posix(context.filename);
    const own = file.match(MODULES)?.[1];
    const inKernel = KERNEL.test(file);
    const inAuth = file.includes("/packages/auth/");
    const inMobile = file.includes("/apps/mobile/");

    function check(node, source, typeOnly, specifiers) {
      if (typeof source !== "string") return;
      if (source === "@flowless/db/auth-schema" && !inAuth) {
        context.report({ node, messageId: "authSchema" });
        return;
      }
      if (inMobile && source.startsWith("@flowless/api") && !typeOnly) {
        context.report({ node, messageId: "mobileRuntime" });
        return;
      }
      const schema = source.match(/^@flowless\/db\/schema\/([^/]+)/);
      if (own && schema && schema[1] !== own) {
        context.report({ node, messageId: "otherSchema", data: { target: schema[1] } });
        return;
      }
      if (!source.startsWith(".")) return;
      const resolved = posix(path.resolve(path.dirname(file), source));
      const target = resolved.match(MODULES);
      if (target && (own || inKernel) && target[1] !== own && !isIndex(target[2])) {
        context.report({ node, messageId: "otherModule", data: { target: target[1] } });
        return;
      }
      if (own && /\/packages\/api\/src\/trpc(\.ts)?$/.test(resolved) && !typeOnly) {
        for (const s of specifiers) {
          if (s.type === "ImportSpecifier" && BUILDERS.has(s.imported.name ?? s.imported.value)) {
            context.report({ node: s, messageId: "builder" });
          }
        }
      }
    }

    return {
      ImportDeclaration: (node) => check(node, node.source.value, node.importKind === "type", node.specifiers),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source.value, node.exportKind === "type", []),
      ExportAllDeclaration: (node) => check(node, node.source.value, node.exportKind === "type", []),
      ImportExpression: (node) => node.source.type === "Literal" && check(node, node.source.value, false, []),
    };
  },
};

export const plugin = { meta: { name: "flowless" }, rules: { "module-boundaries": moduleBoundaries } };

/** Add to any flat config: `[...config, boundaries]`. */
export const boundaries = { plugins: { flowless: plugin }, rules: { "flowless/module-boundaries": "error" } };
