import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { pure } from "./pure.js";

const linter = new Linter();
const configs = [{ files: ["**/*.ts"], languageOptions: { parser: tseslint.parser, sourceType: "module", ecmaVersion: 2024 } }, ...pure.map((c) => ({ ...c, files: ["**/*.ts"] }))];
const lint = (code) => linter.verify(code, configs, { filename: "x.ts" });
const rules = (code) => lint(code).map((m) => m.ruleId);

describe("pure config", () => {
  it.each([
    [`import { db } from "@flowless/db";`, "no-restricted-imports"],
    [`import { x } from "@flowless/db/schema/billing";`, "no-restricted-imports"],
    [`import fs from "node:fs";`, "no-restricted-imports"],
    [`import { readFile } from "node:fs/promises";`, "no-restricted-imports"],
    [`import fs from "fs";`, "no-restricted-imports"],
    [`import http from "http";`, "no-restricted-imports"],
    [`import axios from "axios";`, "no-restricted-imports"],
    [`import fetch from "node-fetch";`, "no-restricted-imports"],
    [`import { sql } from "drizzle-orm";`, "no-restricted-imports"],
    [`await fetch("https://x");`, "no-restricted-globals"],
    [`new XMLHttpRequest();`, "no-restricted-globals"],
    [`const t = Date.now();`, "no-restricted-properties"],
    [`const r = Math.random();`, "no-restricted-properties"],
    [`const d = new Date();`, "no-restricted-syntax"],
  ])("rejects %s", (code, rule) => {
    expect(rules(code)).toContain(rule);
  });

  it.each([
    `import { sum } from "./money";`,
    `import type { Foo } from "@flowless/shared-types";`,
    `import { describe } from "vitest";`,
    `const d = new Date("2026-01-01");`,
    `const n = BigInt(5) * 2n;`,
  ])("allows %s", (code) => {
    expect(lint(code)).toEqual([]);
  });
});
