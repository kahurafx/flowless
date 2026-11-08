"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FieldSelect } from "@/components/field-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addCrewMember, archiveCrew, createCrew, removeCrewMember, renameCrew, type Result } from "../actions";

interface CrewView {
  id: string;
  name: string;
  members: { id: string; name: string }[];
}

export function CrewsManager({ crews, people, canManage }: { crews: CrewView[]; people: { id: string; name: string }[]; canManage: boolean }) {
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const act = (change: () => Promise<Result<unknown>>, done: string, then?: () => void) =>
    startTransition(async () => {
      const result = await change();
      if (result.error !== null) toast.error(result.error);
      else {
        toast.success(done);
        then?.();
      }
    });

  return (
    <div className="grid max-w-3xl gap-4">
      {canManage && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            act(() => createCrew(name.trim()), "Crew created", () => setName(""));
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="crew-name">New crew</Label>
            <Input id="crew-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="For example Leak repair team" className="w-72 max-w-full" />
          </div>
          <Button type="submit" disabled={pending || !name.trim()}>
            <PlusIcon />
            Add crew
          </Button>
        </form>
      )}
      {crews.length === 0 && <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">No crews yet.</p>}
      {crews.map((crew) => (
        <CrewCard key={crew.id} crew={crew} people={people} canManage={canManage} pending={pending} act={act} />
      ))}
    </div>
  );
}

function CrewCard({
  crew,
  people,
  canManage,
  pending,
  act,
}: {
  crew: CrewView;
  people: { id: string; name: string }[];
  canManage: boolean;
  pending: boolean;
  act: (change: () => Promise<Result<unknown>>, done: string, then?: () => void) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(crew.name);
  const [adding, setAdding] = useState("");
  const free = people.filter((p) => !crew.members.some((m) => m.id === p.id));
  return (
    <section className="grid gap-3 rounded-xl border bg-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        {renaming ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => renameCrew(crew.id, name.trim()), "Crew renamed", () => setRenaming(false));
            }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Crew name" maxLength={100} />
            <Button type="submit" disabled={pending || !name.trim()}>
              Save
            </Button>
          </form>
        ) : (
          <h2 className="text-base font-semibold">{crew.name}</h2>
        )}
        {canManage && !renaming && (
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>
              Rename
            </Button>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => act(() => archiveCrew(crew.id), "Crew archived")}>
              Archive
            </Button>
          </div>
        )}
      </header>
      {crew.members.length === 0 ? (
        <p className="text-sm text-muted-foreground">No members yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label={`${crew.name} members`}>
          {crew.members.map((m) => (
            <li key={m.id} className="inline-flex items-center gap-1 rounded-full border bg-background py-1 pr-1 pl-3 text-sm">
              {m.name}
              {canManage && (
                <button
                  type="button"
                  aria-label={`Remove ${m.name}`}
                  className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:size-9"
                  disabled={pending}
                  onClick={() => act(() => removeCrewMember(crew.id, m.id), `${m.name} removed`)}
                >
                  <XIcon className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && free.length > 0 && (
        <div className="flex max-w-sm gap-2">
          <FieldSelect value={adding} onChange={setAdding} options={free.map((p) => ({ value: p.id, label: p.name }))} placeholder="Add a member" />
          <Button variant="outline" disabled={pending || !adding} onClick={() => act(() => addCrewMember(crew.id, adding), "Member added", () => setAdding(""))}>
            Add
          </Button>
        </div>
      )}
    </section>
  );
}
