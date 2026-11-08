import { randomUUID } from "expo-crypto";

/**
 * Client-minted ids. The API takes uuids for every id the phone makes up (entities, event ids, file
 * ids), which is what makes an offline create and a retried sync safe.
 */
export const uid = (): string => randomUUID();
export const now = (): string => new Date().toISOString();
