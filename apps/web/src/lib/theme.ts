/** A per-viewer preference, kept in localStorage. "system" follows the OS setting. */
export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "flowless-theme";

/** Applies a preference to <html>. Shared by the pre-paint script and the toggle. */
export function applyTheme(preference: ThemePreference): void {
  const dark =
    preference === "dark" ||
    (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/**
 * Runs synchronously in <head> before first paint, so there is no light flash for dark
 * users (Next guide: preventing-flash-before-hydration). Kept in sync with `applyTheme`.
 */
export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_STORAGE_KEY}")||"system";var d=p==="dark"||(p==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;
