"use client";

import { useCallback, useState } from "react";

export interface Position {
  latitude: number;
  longitude: number;
  accuracyM: number;
}

type Status = "idle" | "locating" | "found" | "denied";

/** The device position on request (W-02): never asked for until the person is finishing something that needs it. */
export function usePosition() {
  const [position, setPosition] = useState<Position | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const request = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus("denied");
      return;
    }
    setStatus("locating");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setPosition({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: p.coords.accuracy });
        setStatus("found");
      },
      () => setStatus("denied"),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  }, []);
  return { position, status, request };
}

export const formatPosition = (p: { latitude: number; longitude: number }) => `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`;
