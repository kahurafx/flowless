import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { boundaries } from "./boundaries.js";

/** @type {import("eslint").Linter.Config[]} */
export const config = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  boundaries,
  { ignores: ["dist/**", "node_modules/**"] },
];
