"use client";

import { CrosshairIcon } from "lucide-react";
import { toast } from "sonner";
import { FieldSelect } from "@/components/field-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PlaceState } from "@/lib/account-forms";
import { areaChoices, stillOffered, type AreaChoice } from "@/lib/area-options";

export interface PlaceOptions {
  areas: readonly AreaChoice[];
  routes: readonly { id: string; name: string }[];
}

/**
 * Where a service point (or an enquiry, or a relocation's new place) is: address, the scheme,
 * zone and DMA it falls in, its route and GPS coordinates (a map picker is a later step). Each
 * picker offers what sits under the one above it.
 */
export function PlaceFields({
  idPrefix,
  options,
  value,
  onChange,
}: {
  idPrefix: string;
  options: PlaceOptions;
  value: PlaceState;
  onChange: (next: PlaceState) => void;
}) {
  const set = (patch: Partial<PlaceState>) => {
    const next = { ...value, ...patch };
    // A change above can make a choice below impossible: drop it rather than send a chain the API will refuse.
    if (!stillOffered(areaChoices(options.areas, ["zone", "sub_zone"], [next.schemeId]), next.zoneId)) next.zoneId = "";
    if (!stillOffered(areaChoices(options.areas, ["dma"], [next.schemeId, next.zoneId]), next.dmaId)) next.dmaId = "";
    onChange(next);
  };
  const schemes = areaChoices(options.areas, ["scheme"], []);
  const zones = areaChoices(options.areas, ["zone", "sub_zone"], [value.schemeId]);
  const dmas = areaChoices(options.areas, ["dma"], [value.schemeId, value.zoneId]);

  const locate = () =>
    navigator.geolocation.getCurrentPosition(
      (p) => set({ lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6) }),
      () => toast.error("Couldn't read your position. Enter it by hand."),
      { enableHighAccuracy: true, timeout: 10_000 },
    );

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-address`}>Address</Label>
        <Input id={`${idPrefix}-address`} value={value.address} onChange={(e) => set({ address: e.target.value })} maxLength={300} placeholder="Plot, street or landmark" required />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {schemes.length > 0 && (
          <div className="grid gap-2">
            <Label htmlFor={`${idPrefix}-scheme`}>Scheme</Label>
            <FieldSelect id={`${idPrefix}-scheme`} value={value.schemeId} onChange={(v) => set({ schemeId: v })} options={schemes} placeholder="Not set" none="Not set" />
          </div>
        )}
        {(zones.length > 0 || value.zoneId) && (
          <div className="grid gap-2">
            <Label htmlFor={`${idPrefix}-zone`}>Zone</Label>
            <FieldSelect id={`${idPrefix}-zone`} value={value.zoneId} onChange={(v) => set({ zoneId: v })} options={zones} placeholder="Not set" none="Not set" />
          </div>
        )}
        {(dmas.length > 0 || value.dmaId) && (
          <div className="grid gap-2">
            <Label htmlFor={`${idPrefix}-dma`}>DMA</Label>
            <FieldSelect id={`${idPrefix}-dma`} value={value.dmaId} onChange={(v) => set({ dmaId: v })} options={dmas} placeholder="Not set" none="Not set" />
          </div>
        )}
      </div>
      {options.routes.length > 0 && (
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-route`}>Route</Label>
          <FieldSelect
            id={`${idPrefix}-route`}
            value={value.routeId}
            onChange={(v) => set({ routeId: v })}
            options={options.routes.map((r) => ({ value: r.id, label: r.name }))}
            placeholder="Not set"
            none="Not set"
          />
        </div>
      )}
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">GPS position (optional)</legend>
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <Input value={value.lat} onChange={(e) => set({ lat: e.target.value })} inputMode="decimal" placeholder="Latitude" aria-label="Latitude" />
          <Input value={value.lng} onChange={(e) => set({ lng: e.target.value })} inputMode="decimal" placeholder="Longitude" aria-label="Longitude" />
          <Button type="button" variant="outline" onClick={locate} aria-label="Use my position">
            <CrosshairIcon />
            <span className="hidden sm:inline">Here</span>
          </Button>
        </div>
      </fieldset>
    </div>
  );
}
