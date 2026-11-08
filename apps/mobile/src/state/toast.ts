import { createContext, useContext } from "react";
import type { HapticCue } from "../lib/haptics";

export type ShowToast = (message: string, cue?: HapticCue) => void;

export const ToastContext = createContext<ShowToast | null>(null);

/** A short message at the top of the screen, with an optional haptic cue. */
export function useToast(): ShowToast {
  const v = useContext(ToastContext);
  if (!v) throw new Error("useToast must be used inside <AppProvider>");
  return v;
}
