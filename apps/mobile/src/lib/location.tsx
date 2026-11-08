import * as Location from "expo-location";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Linking } from "react-native";
import type { LatLng } from "./types";

export type LocationStatus = "unknown" | "granted" | "denied";

type Fix = { point: LatLng; accuracyM: number | null };
type Value = {
  status: LocationStatus;
  /** Latest fix, or null before there is one. */
  point: LatLng | null;
  accuracyM: number | null;
  /** Ask for permission (or open Settings if it was refused for good). Resolves true when granted. */
  request: () => Promise<boolean>;
  /** One fresh, high-accuracy reading. */
  refresh: () => Promise<Fix | null>;
};

const Ctx = createContext<Value | null>(null);

export function useLocation(): Value {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLocation must be used inside <LocationProvider>");
  return v;
}

const toFix = (loc: Location.LocationObject): Fix => ({
  point: { lat: loc.coords.latitude, lng: loc.coords.longitude },
  accuracyM: loc.coords.accuracy ?? null,
});

/**
 * One position watcher for the whole app (map, Home's nearest-job ranking, capture). It never
 * prompts by itself: it starts watching only once permission has been granted, so the person sees
 * why we ask first.
 */
export function LocationProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LocationStatus>("unknown");
  const [fix, setFix] = useState<Fix | null>(null);
  const watcher = useRef<Location.LocationSubscription | null>(null);

  const startWatching = useCallback(async () => {
    if (watcher.current) return;
    watcher.current = await Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, distanceInterval: 15, timeInterval: 10_000 }, (loc) => setFix(toFix(loc)));
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const p = await Location.getForegroundPermissionsAsync();
      if (!alive) return;
      if (p.granted) {
        setStatus("granted");
        void startWatching();
      } else if (p.status === "denied") {
        setStatus("denied");
      }
    })();
    return () => {
      alive = false;
      watcher.current?.remove();
      watcher.current = null;
    };
  }, [startWatching]);

  const request = useCallback(async () => {
    const current = await Location.getForegroundPermissionsAsync();
    if (current.status === "denied" && !current.canAskAgain) {
      await Linking.openSettings();
      return false;
    }
    const p = await Location.requestForegroundPermissionsAsync();
    if (p.granted) {
      setStatus("granted");
      await startWatching();
      return true;
    }
    setStatus("denied");
    return false;
  }, [startWatching]);

  const refresh = useCallback(async () => {
    try {
      const next = toFix(await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }));
      setFix(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  const value = useMemo<Value>(() => ({ status, point: fix?.point ?? null, accuracyM: fix?.accuracyM ?? null, request, refresh }), [status, fix, request, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
