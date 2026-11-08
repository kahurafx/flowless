"use client";

import { SearchIcon } from "lucide-react";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

export interface AssetChoice {
  id: string;
  label: string;
}

const SHOWN = 8;

/** Find assets by name and pick one (or several). Long lists are searched, never scrolled through. */
export function AssetPicker({
  assets,
  selected,
  onChange,
  multiple = false,
}: {
  assets: readonly AssetChoice[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  multiple?: boolean;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = (needle ? assets.filter((a) => a.label.toLowerCase().includes(needle)) : assets).slice(0, SHOWN);
  const chosen = assets.filter((a) => selected.includes(a.id));
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : multiple ? [...selected, id] : [id]);
  return (
    <div className="grid gap-2">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search assets by name" aria-label="Search assets" className="pl-8" />
      </div>
      {chosen.length > 0 && <p className="text-sm">Chosen: {chosen.map((a) => a.label).join(", ")}</p>}
      <ul className="grid gap-1 rounded-lg border p-1" aria-label="Assets">
        {matches.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">No asset matches.</li>}
        {matches.map((a) => (
          <li key={a.id}>
            <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
              <Checkbox checked={selected.includes(a.id)} onCheckedChange={() => toggle(a.id)} />
              <span className="min-w-0 break-words">{a.label}</span>
            </label>
          </li>
        ))}
      </ul>
      {assets.length > SHOWN && !needle && <p className="text-xs text-muted-foreground">Showing {SHOWN} of {assets.length}. Search to narrow down.</p>}
    </div>
  );
}
