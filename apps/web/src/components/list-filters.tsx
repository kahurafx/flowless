"use client";

import { ArrowRightIcon, SearchIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FieldSelect } from "@/components/field-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface ListFilter {
  /** The URL parameter that carries the choice. */
  param: string;
  /** Shown when nothing is chosen ("All statuses"). */
  label: string;
  options: readonly { value: string; label: string }[];
}

/** The URL with `changes` applied (a null or empty value removes the parameter); paging restarts. */
export function withParams(current: URLSearchParams, changes: Record<string, string | null>): string {
  const next = new URLSearchParams(current);
  next.delete("after");
  for (const [key, value] of Object.entries(changes)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  const query = next.toString();
  return query ? `?${query}` : "?";
}

/**
 * A server-driven list's search box and filters. The state lives in the URL (so a view can be
 * shared and the back button works) and the server page reads it; typing waits a moment so
 * each keystroke is not a request.
 */
export function ListFilters({ search, filters = [] }: { search?: { param?: string; placeholder: string }; filters?: readonly ListFilter[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const searchParam = search?.param ?? "q";
  const urlValue = params.get(searchParam) ?? "";
  const [typed, setTyped] = useState(urlValue);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // The URL is the truth: follow it when it changes from elsewhere (back button, clear).
  const [seen, setSeen] = useState(urlValue);
  if (seen !== urlValue) {
    setSeen(urlValue);
    setTyped(urlValue);
  }
  useEffect(() => () => clearTimeout(timer.current), []);

  const go = (changes: Record<string, string | null>) => router.replace(`${pathname}${withParams(new URLSearchParams(params), changes)}`, { scroll: false });
  const onType = (value: string) => {
    setTyped(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => go({ [searchParam]: value.trim() || null }), 300);
  };
  const filtered = urlValue !== "" || filters.some((f) => params.get(f.param));

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {search && (
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={typed} onChange={(e) => onType(e.target.value)} placeholder={search.placeholder} aria-label={search.placeholder} className="pl-8" type="search" />
        </div>
      )}
      {filters.map((f) => (
        <FieldSelect
          key={f.param}
          value={params.get(f.param) ?? ""}
          onChange={(v) => go({ [f.param]: v || null })}
          options={f.options}
          placeholder={f.label}
          none={f.label}
          className="w-auto min-w-40"
        />
      ))}
      {filtered && (
        <Button variant="ghost" onClick={() => go(Object.fromEntries([searchParam, ...filters.map((f) => f.param)].map((p) => [p, null])))}>
          <XIcon />
          Clear
        </Button>
      )}
    </div>
  );
}

/** The link to the next page of a keyset-paged list. */
export function NextPage({ cursor }: { cursor: string | null }) {
  const params = useSearchParams();
  const pathname = usePathname();
  if (!cursor) return null;
  const next = new URLSearchParams(params);
  next.set("after", cursor);
  return (
    <div className="mt-3 flex justify-end">
      <Button variant="outline" render={<Link href={`${pathname}?${next.toString()}`} />}>
        Next page
        <ArrowRightIcon />
      </Button>
    </div>
  );
}
