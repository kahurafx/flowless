"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { useMintedId } from "@/components/accounts/reason-form";
import { FieldSelect } from "@/components/field-select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isPeriod } from "@/lib/cycle-view";
import { openCycleAction } from "./actions";

/** B-02, B-03: opening a cycle fixes the route's eligible accounts. The same route and period opens the same cycle. */
export function OpenCycleDialog({ routes, defaultPeriod }: { routes: { id: string; name: string }[]; defaultPeriod: string }) {
  const router = useRouter();
  const [id, mint] = useMintedId();
  const [routeId, setRouteId] = useState("");
  const [period, setPeriod] = useState(defaultPeriod);
  const [cycleDate, setCycleDate] = useState("");
  return (
    <ActionDialog
      label="Open a cycle"
      icon={<PlusIcon />}
      variant="default"
      title="Open a billing cycle"
      description="Opening takes the route's eligibility snapshot: the accounts expected to be billed, each with the reason it is or is not. Opening again for the same route and period returns the same cycle."
      submitLabel="Open cycle"
      success="Cycle opened"
      onOpen={mint}
      canSubmit={routeId !== "" && isPeriod(period)}
      onSubmit={async () => {
        const result = await openCycleAction({ id, routeId, period, cycleDate });
        if (result.error === null) router.push(`/billing/cycles/${result.data.id}`);
        return { error: result.error };
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="cycle-route">Route</Label>
        <FieldSelect id="cycle-route" value={routeId} onChange={setRouteId} options={routes.map((r) => ({ value: r.id, label: r.name }))} placeholder="Choose a route" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="cycle-period">Period (year-month)</Label>
        <Input id="cycle-period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-05" inputMode="numeric" pattern="\d{4}-\d{2}" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="cycle-date">Cycle date (optional)</Label>
        <Input id="cycle-date" type="date" value={cycleDate} onChange={(e) => setCycleDate(e.target.value)} />
        <p className="text-xs text-muted-foreground">The day the snapshot is for. Left empty it is the last day of the period.</p>
      </div>
    </ActionDialog>
  );
}
