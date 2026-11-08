import * as SecureStore from "expo-secure-store";

/** Who used this phone last, so it can open their data without a connection. */
const KEY = "flowless_last_user";

export const readLastUser = (): Promise<string | null> => SecureStore.getItemAsync(KEY).catch(() => null);
export const writeLastUser = (userId: string) => SecureStore.setItemAsync(KEY, userId).catch(() => undefined);
export const clearLastUser = () => SecureStore.deleteItemAsync(KEY).catch(() => undefined);

/** The organization code typed last, so the sign-in screen can fill it in. A convenience, never trusted. */
const CODE_KEY = "flowless_org_code";
export const readOrgCode = (): Promise<string | null> => SecureStore.getItemAsync(CODE_KEY).catch(() => null);
export const writeOrgCode = (code: string) => SecureStore.setItemAsync(CODE_KEY, code).catch(() => undefined);
