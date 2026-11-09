import type { Transaction } from "@flowless/db";
import type { ModuleKey } from "@flowless/shared-types";
import { loadEntitlements } from "./entitlement-store";

/*
 * Process-global port registries (NF-30, NF-31). A module that owns a fact another module
 * needs (Billing's ledger, Metering's readings) registers a handler once, at start-up, through
 * the asking module's published interface; the asking module resolves the handler inside the
 * caller's tenant transaction. Registries are global to the process, so every entry carries
 * `requires`: the modules that must all be licensed for the organization before the handler
 * is used. An unlicensed module is therefore never asked and never changes the outcome.
 */

export interface PortOptions {
  /** Modules that must all be licensed for the organization before the handler is used. Default: none. */
  requires?: readonly ModuleKey[];
}

interface Entry<T> {
  handler: T;
  requires: readonly ModuleKey[];
}

type Licences = () => Promise<readonly ModuleKey[]>;

/** The organization's licensed modules, loaded at most once and only if some entry needs them. */
const lazyLicences = (tx: Transaction): Licences => {
  let loaded: Promise<readonly ModuleKey[]> | undefined;
  return () => (loaded ??= loadEntitlements(tx));
};

async function usable<T>(entry: Entry<T> | undefined, licences: Licences): Promise<T | null> {
  if (!entry) return null;
  if (entry.requires.length) {
    const licensed = await licences();
    if (!entry.requires.every((m) => licensed.includes(m))) return null;
  }
  return entry.handler;
}

/** Ports addressed by a key (one handler per gate, per rule). */
export interface KeyedPort<K extends string, T> {
  /** Registers (replacing) the handler for a key; null removes it (tests do). */
  register(key: K, handler: T | null, options?: PortOptions): void;
  /** Is a handler registered for the key, licensed or not? */
  has(key: K): boolean;
  /** The key's handler if registered and every required module is licensed, else null. */
  resolve(tx: Transaction, key: K): Promise<T | null>;
  /** `resolve` for several keys, loading the licences at most once. */
  resolveAll(tx: Transaction, keys: readonly K[]): Promise<Map<K, T | null>>;
}

export function defineKeyedPort<K extends string, T>(): KeyedPort<K, T> {
  const entries = new Map<K, Entry<T>>();
  return {
    register(key, handler, options = {}) {
      if (handler === null) entries.delete(key);
      else entries.set(key, { handler, requires: options.requires ?? [] });
    },
    has: (key) => entries.has(key),
    resolve: (tx, key) => usable(entries.get(key), lazyLicences(tx)),
    async resolveAll(tx, keys) {
      const licences = lazyLicences(tx);
      const resolved = new Map<K, T | null>();
      for (const key of keys) resolved.set(key, await usable(entries.get(key), licences));
      return resolved;
    },
  };
}

/** A port with one handler. */
export interface Port<T> {
  register(handler: T | null, options?: PortOptions): void;
  has(): boolean;
  resolve(tx: Transaction): Promise<T | null>;
}

export function definePort<T>(): Port<T> {
  const keyed = defineKeyedPort<"port", T>();
  return {
    register: (handler, options) => keyed.register("port", handler, options),
    has: () => keyed.has("port"),
    resolve: (tx) => keyed.resolve(tx, "port"),
  };
}
