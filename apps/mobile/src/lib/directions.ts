import { Linking, Platform } from "react-native";
import type { LatLng } from "./types";

/** Hands off to the phone's maps app for turn-by-turn. Falls back to a web link that opens Google Maps if installed. */
export async function openDirections(to: LatLng, label: string) {
  const { lat, lng } = to;
  const web = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  const native = Platform.OS === "ios" ? `maps://?daddr=${lat},${lng}&q=${encodeURIComponent(label)}` : `google.navigation:q=${lat},${lng}`;
  try {
    await Linking.openURL(native);
  } catch {
    await Linking.openURL(web);
  }
}
