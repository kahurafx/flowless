"use client";

import { WORK_PRIORITIES, type WorkPriority } from "@flowless/shared-types";
import { CrosshairIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AssetPicker, type AssetChoice } from "@/components/asset-picker";
import { FieldSelect } from "@/components/field-select";
import { priorityLabel } from "@/components/work-badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { JobKind } from "@/data/work-orders";
import { createJob } from "../actions";

interface Props {
  kinds: JobKind[];
  people: { id: string; name: string }[];
  assignAnyone: boolean;
  self: { id: string; name: string };
  areas: { id: string; name: string; level: string }[];
  crews: { id: string; name: string }[];
  assets: (AssetChoice & { at: { lat: number; lng: number } | null })[];
  /** A job raised from elsewhere (an application's survey): the kind, its subject and what to fill in. */
  initial?: { kind: string; assetId: string; title: string; description: string; lat: string; lng: string; locationNote: string } | null;
}

export function NewJobForm({ kinds, people, assignAnyone, self, areas, crews, assets, initial = null }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The id is minted once, so a retried submit cannot raise the job twice.
  const [id] = useState(() => crypto.randomUUID());
  const [kindKey, setKindKey] = useState(initial?.kind ?? kinds[0]?.key ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [priority, setPriority] = useState<WorkPriority | "">("");
  const [assetIds, setAssetIds] = useState<string[]>(initial ? [initial.assetId] : []);
  const [areaId, setAreaId] = useState("");
  const [lat, setLat] = useState(initial?.lat ?? "");
  const [lng, setLng] = useState(initial?.lng ?? "");
  const [locationNote, setLocationNote] = useState(initial?.locationNote ?? "");
  const [assigneeId, setAssigneeId] = useState(assignAnyone ? "" : self.id);
  const [crewId, setCrewId] = useState("");
  const [dueAt, setDueAt] = useState("");

  const kind = kinds.find((k) => k.key === kindKey);
  const target = kind?.target ?? "asset";
  const position = lat !== "" && lng !== "" && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) ? { latitude: Number(lat), longitude: Number(lng) } : null;

  const locate = () =>
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLat(p.coords.latitude.toFixed(6));
        setLng(p.coords.longitude.toFixed(6));
      },
      () => toast.error("Couldn't read your position. Enter it by hand."),
      { enableHighAccuracy: true, timeout: 10_000 },
    );

  const useAssetPosition = (ids: string[]) => {
    setAssetIds(ids);
    const at = assets.find((a) => a.id === ids[0])?.at;
    if (at && position === null) {
      setLat(at.lat.toFixed(6));
      setLng(at.lng.toFixed(6));
    }
  };

  const submit = () =>
    startTransition(async () => {
      if (!kind) return;
      const [primary, ...related] = assetIds;
      const result = await createJob({
        id,
        title,
        description,
        kind: kind.key,
        ...(priority ? { priority } : {}),
        ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}),
        assetId: primary ?? null,
        relatedAssetIds: related,
        areaId: areaId || null,
        routeId: null,
        location: position,
        locationNote: locationNote.trim() || null,
        assigneeId: assigneeId || null,
        crewId: crewId || null,
      });
      if (result.error !== null) toast.error(result.error);
      else {
        toast.success("Job raised");
        router.push(`/work-orders/${result.data}`);
      }
    });

  const needsPlace = (target === "area" && !areaId) || (target === "location" && !position);
  const kindOptions = kinds.map((k) => ({ value: k.key, label: k.label }));
  const hint = kind
    ? [
        kind.review === "required" ? "Needs a second person's approval." : kind.review === "optional" ? "May be sent for approval." : "Completed without review.",
        kind.slaHours ? `Due within ${kind.slaHours} hours unless you set a date.` : "Due in 7 days unless you set a date.",
        kind.evidence.photos ? `Finishing needs ${kind.evidence.photos} photo${kind.evidence.photos === 1 ? "" : "s"}${kind.evidence.gps ? " and a GPS position" : ""}.` : kind.evidence.gps ? "Finishing needs a GPS position." : null,
      ]
        .filter(Boolean)
        .join(" ")
    : "";

  return (
    <form
      className="grid max-w-2xl gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="job-kind">Kind of job</Label>
        <FieldSelect id="job-kind" value={kindKey} onChange={(v) => { setKindKey(v); setAssetIds([]); }} options={kindOptions} placeholder="Choose a kind" />
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="job-title">Title</Label>
        <Input id="job-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required placeholder="What needs doing" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="job-description">Details</Label>
        <Textarea id="job-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={4000} />
      </div>

      {(target === "asset" || target === "assets") && assets.length > 0 && (
        <div className="grid gap-2">
          <Label>{target === "assets" ? "Assets on this job" : "Asset"}</Label>
          <AssetPicker assets={assets} selected={assetIds} onChange={useAssetPosition} multiple={target === "assets"} />
        </div>
      )}
      {(target === "area" || areas.length > 0) && (
        <div className="grid gap-2">
          <Label htmlFor="job-area">Area{target === "area" ? "" : " (optional)"}</Label>
          <FieldSelect
            id="job-area"
            value={areaId}
            onChange={setAreaId}
            options={areas.map((a) => ({ value: a.id, label: a.name }))}
            placeholder="Choose an area"
            none={target === "area" ? undefined : "No area"}
          />
        </div>
      )}
      {(target === "location" || target === "asset") && (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Position{target === "location" ? "" : " (optional)"}</legend>
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
            <Input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" placeholder="Latitude" aria-label="Latitude" />
            <Input value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" placeholder="Longitude" aria-label="Longitude" />
            <Button type="button" variant="outline" onClick={locate} aria-label="Use my position">
              <CrosshairIcon />
              <span className="hidden sm:inline">Here</span>
            </Button>
          </div>
          <Input value={locationNote} onChange={(e) => setLocationNote(e.target.value)} placeholder="Where exactly, for the crew" aria-label="Location note" maxLength={300} />
        </fieldset>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="job-assignee">Assigned to</Label>
          {assignAnyone ? (
            <FieldSelect id="job-assignee" value={assigneeId} onChange={setAssigneeId} options={people.map((p) => ({ value: p.id, label: p.name }))} placeholder="Unassigned" none="Unassigned" />
          ) : (
            <Input id="job-assignee" value={self.name} disabled aria-label="Assigned to you" />
          )}
        </div>
        {assignAnyone && crews.length > 0 && (
          <div className="grid gap-2">
            <Label htmlFor="job-crew">Crew</Label>
            <FieldSelect id="job-crew" value={crewId} onChange={setCrewId} options={crews.map((c) => ({ value: c.id, label: c.name }))} placeholder="No crew" none="No crew" />
          </div>
        )}
        {assignAnyone && (
          <div className="grid gap-2">
            <Label htmlFor="job-priority">Priority</Label>
            <FieldSelect
              id="job-priority"
              value={priority}
              onChange={(v) => setPriority(v as WorkPriority | "")}
              options={WORK_PRIORITIES.map((p) => ({ value: p, label: priorityLabel[p] }))}
              placeholder={`Default (${priorityLabel[kind?.defaultPriority ?? "normal"]})`}
              none={`Default (${priorityLabel[kind?.defaultPriority ?? "normal"]})`}
            />
          </div>
        )}
        <div className="grid gap-2">
          <Label htmlFor="job-due">Due (optional)</Label>
          <Input id="job-due" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </div>
      </div>
      {!assignAnyone && <p className="text-xs text-muted-foreground">A job you raise yourself is assigned to you and goes for review when you finish it.</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending || !kind || !title.trim() || needsPlace}>
          Raise job
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
