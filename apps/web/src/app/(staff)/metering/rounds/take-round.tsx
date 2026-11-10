"use client";

import { CameraIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { FieldSelect } from "@/components/field-select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { takeSnapshotAction } from "../actions";

/** M-08: fixes the route's eligibility for a cycle date. Asking again for the same route and date returns the first. */
export function TakeRoundDialog({ routes }: { routes: { id: string; name: string }[] }) {
  const router = useRouter();
  const [routeId, setRouteId] = useState("");
  const [cycleDate, setCycleDate] = useState("");
  return (
    <ActionDialog
      label="Take a snapshot"
      icon={<CameraIcon />}
      variant="default"
      title="Take an eligibility snapshot"
      description="Fixes which service points are read and billed for a route and cycle date. The billing cycle for the same route and date uses this same snapshot."
      submitLabel="Take snapshot"
      success="Snapshot taken"
      canSubmit={routeId !== "" && cycleDate !== ""}
      onSubmit={async () => {
        const result = await takeSnapshotAction({ routeId, cycleDate });
        if (result.error === null) router.push(`/metering/rounds/${result.data.id}`);
        return { error: result.error };
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="round-route">Route</Label>
        <FieldSelect id="round-route" value={routeId} onChange={setRouteId} options={routes.map((r) => ({ value: r.id, label: r.name }))} placeholder="Choose a route" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="round-date">Cycle date</Label>
        <Input id="round-date" type="date" value={cycleDate} onChange={(e) => setCycleDate(e.target.value)} className="w-auto" required />
      </div>
    </ActionDialog>
  );
}
