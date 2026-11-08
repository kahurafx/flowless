import { useColorScheme } from "react-native";

/**
 * Design tokens, taken from apps/web/src/app/globals.css (the oklch values there, as hex) so the
 * phone and the web app read as one product. Light first, with the slate-950 dark theme. Keep the
 * two files in step: when a token changes on the web, change it here.
 */
export type Palette = {
  background: string;
  foreground: string;
  card: string;
  popover: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  border: string;
  input: string;
  success: string;
  warning: string;
  info: string;
  highlight: string;
  /** Soft fills behind status text, derived from the status colours. */
  successSoft: string;
  warningSoft: string;
  infoSoft: string;
  destructiveSoft: string;
};

export const LIGHT: Palette = {
  background: "#F8FAFC",
  foreground: "#0F172A",
  card: "#FFFFFF",
  popover: "#FFFFFF",
  primary: "#1E40AF",
  primaryForeground: "#FFFFFF",
  secondary: "#E9EEF6",
  secondaryForeground: "#1E3A8A",
  muted: "#EEF2F7",
  mutedForeground: "#475569",
  accent: "#E6EDFA",
  accentForeground: "#1E3A8A",
  destructive: "#DC2626",
  border: "#DBE3EF",
  input: "#8392A8",
  success: "#15803D",
  warning: "#B45309",
  info: "#2563EB",
  highlight: "#D97706",
  successSoft: "#DCFCE7",
  warningSoft: "#FEF3C7",
  infoSoft: "#DBEAFE",
  destructiveSoft: "#FEE2E2",
};

export const DARK: Palette = {
  background: "#020617",
  foreground: "#F8FAFC",
  card: "#0E1223",
  popover: "#131A30",
  primary: "#60A5FA",
  primaryForeground: "#020617",
  secondary: "#1B2540",
  secondaryForeground: "#DBEAFE",
  muted: "#1A2036",
  mutedForeground: "#94A3B8",
  accent: "#1F2B50",
  accentForeground: "#DBEAFE",
  destructive: "#F87171",
  border: "#243049",
  input: "#5B6B85",
  success: "#4ADE80",
  warning: "#FBBF24",
  info: "#60A5FA",
  highlight: "#F59E0B",
  successSoft: "#0F2A1C",
  warningSoft: "#2E2410",
  infoSoft: "#14233F",
  destructiveSoft: "#3A1519",
};

/** Colours for the current appearance, and whether it is dark (for the map style and icons). */
export function useTheme() {
  const dark = useColorScheme() === "dark";
  return { dark, c: dark ? DARK : LIGHT };
}

/** The tailwind scale the web uses. 16 is body; labels over data are 11 with positive tracking. */
export const type = {
  caption: { fontSize: 12, lineHeight: 16 },
  small: { fontSize: 14, lineHeight: 20 },
  body: { fontSize: 16, lineHeight: 24 },
  lead: { fontSize: 18, lineHeight: 26 },
  title: { fontSize: 20, lineHeight: 26, fontWeight: "600" as const, letterSpacing: -0.28 },
  heading: { fontSize: 24, lineHeight: 30, fontWeight: "700" as const, letterSpacing: -0.5 },
  label: { fontSize: 11, lineHeight: 14, fontWeight: "600" as const, letterSpacing: 0.44, textTransform: "uppercase" as const },
} as const;

/** Radius scale: the web's --radius is 0.625rem (10). */
export const radius = { sm: 6, md: 8, lg: 10, xl: 14, "2xl": 18, "3xl": 22, full: 999 } as const;

/** Four-point spacing. */
export const space = (n: number) => n * 4;

/** Minimum touch target, in points (Apple HIG). */
export const TOUCH = 44;

/** Clearance a scroll view on a tab leaves at the bottom for the floating "+" button. */
export const TAB_SPACE = 96;
