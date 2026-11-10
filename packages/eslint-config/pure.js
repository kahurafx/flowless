/**
 * Purity rules for packages that must do no I/O (packages/billing-engine, NF-22, docs/build-plan.md
 * Phase 4): no database, no Node built-ins, no network libraries or globals, no clock or randomness.
 * Add after the base config: `[...config, ...pure]`.
 */
const NODE_BUILTINS = [
  "assert", "buffer", "child_process", "cluster", "crypto", "dgram", "dns", "events", "fs", "http", "http2",
  "https", "net", "os", "path", "perf_hooks", "process", "readline", "stream", "tls", "url", "util", "vm",
  "worker_threads", "zlib",
];
const NETWORK_LIBS = ["axios", "got", "undici", "node-fetch", "cross-fetch", "isomorphic-fetch", "ky", "superagent", "ws", "socket.io-client"];

/** @type {import("eslint").Linter.Config[]} */
export const pure = [
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [...NODE_BUILTINS, ...NETWORK_LIBS, "@flowless/db", "drizzle-orm", "pg", "postgres"].map((name) => ({
            name,
            message: "The billing engine is pure: no I/O, database or network imports.",
          })),
          patterns: [
            { group: ["node:*"], message: "The billing engine is pure: no node:* imports." },
            { group: ["@flowless/db/*", "drizzle-orm/*", "@flowless/api", "@flowless/api/*"], message: "The billing engine is pure: no database or API imports." },
            { group: NETWORK_LIBS.map((n) => `${n}/*`), message: "The billing engine is pure: no network libraries." },
            { group: NODE_BUILTINS.map((n) => `${n}/*`), message: "The billing engine is pure: no Node built-ins." },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "process", "require"].map((name) => ({
          name,
          message: "The billing engine is pure: no I/O globals.",
        })),
      ],
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "No clock in the billing engine: pass periods and dates in." },
        { object: "Math", property: "random", message: "No randomness in the billing engine." },
        { object: "globalThis", property: "fetch", message: "The billing engine is pure: no network." },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: "No clock in the billing engine: pass dates in." },
        { selector: "TSImportEqualsDeclaration", message: "Use ES imports so the purity rules can see them." },
      ],
    },
  },
];
