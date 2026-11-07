"use client";

import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_equalsString,
  filterFn_includesString,
  globalFilteringFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnDef,
  type ColumnFiltersState,
  type RowData,
  type TableFeatures,
  type CellData,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpIcon, BookmarkIcon, SearchIcon, XIcon } from "lucide-react";
import { useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** One feature set for every grid: client filtering, global search and sorting. */
export const gridFeatures = tableFeatures({
  columnVisibilityFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: { includesString: filterFn_includesString, equalsString: filterFn_equalsString },
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    text: sortFn_text,
    datetime: sortFn_datetime,
    basic: sortFn_basic,
    // Money minor units: compare as bigint, never via Number (B-18).
    bigint: (rowA, rowB, columnId) => {
      const a = rowA.getValue<bigint>(columnId);
      const b = rowB.getValue<bigint>(columnId);
      return a < b ? -1 : a > b ? 1 : 0;
    },
  },
});

export type GridFeatures = typeof gridFeatures;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- column value types vary per column
export type GridColumn<T extends RowData> = ColumnDef<GridFeatures, T, any>;
export const gridColumnHelper = <T extends RowData>() => createColumnHelper<GridFeatures, T>();

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- must match the library's generics
  interface ColumnMeta<TFeatures extends TableFeatures, TData extends RowData, TValue extends CellData = CellData> {
    /** Numeric columns (money, readings, counts) align to the end. */
    align?: "start" | "end";
  }
}

export interface Facet {
  /** A column whose accessor returns a string and uses `filterFn: "equalsString"`. */
  columnId: string;
  label: string;
  options: readonly { value: string; label: string }[];
}

interface SavedView {
  name: string;
  globalFilter: string;
  columnFilters: ColumnFiltersState;
  sorting: SortingState;
}

const ALL = "__all";

export function DataGrid<T extends RowData>({
  data,
  columns,
  getRowId,
  facets = [],
  searchPlaceholder,
  viewsKey,
  emptyMessage,
  onOpenRow,
  initialSorting = [],
  initialColumnFilters = [],
  hiddenColumns = [],
}: {
  data: T[];
  columns: GridColumn<T>[];
  getRowId: (row: T) => string;
  facets?: readonly Facet[];
  searchPlaceholder: string;
  /** Saved views are a per-viewer convenience, kept in localStorage under this key. */
  viewsKey: string;
  emptyMessage: string;
  onOpenRow?: (row: T) => void;
  initialSorting?: SortingState;
  /** For deep links such as /exceptions?type=NO_BASELINE. */
  initialColumnFilters?: ColumnFiltersState;
  /** Filter-only columns: they drive facets but take no space. */
  hiddenColumns?: readonly string[];
}) {
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(initialColumnFilters);
  const [sorting, setSorting] = useState<SortingState>(initialSorting);

  const table = useTable({
    features: gridFeatures,
    columns,
    data,
    getRowId,
    state: { globalFilter, columnFilters, sorting },
    initialState: { columnVisibility: Object.fromEntries(hiddenColumns.map((id) => [id, false])) },
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onSortingChange: setSorting,
    globalFilterFn: "includesString",
    enableSortingRemoval: false,
  });

  const rows = table.getRowModel().rows;
  const views = useSavedViews(viewsKey);
  const filtered = globalFilter !== "" || columnFilters.length > 0;

  // Roving focus: one row is tabbable; arrows or j/k move, Enter opens (NF-40).
  const [activeIndexState, setActiveIndex] = useState(0);
  // Clamped at render: filtering can shrink the list under the focused row.
  const activeIndex = Math.max(0, Math.min(activeIndexState, rows.length - 1));
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const focusRow = (index: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setActiveIndex(next);
    bodyRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-row]")[next]?.focus();
  };

  const onBodyKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "j") focusRow(activeIndex + 1);
    else if (e.key === "ArrowUp" || e.key === "k") focusRow(activeIndex - 1);
    else if (e.key === "Home") focusRow(0);
    else if (e.key === "End") focusRow(rows.length - 1);
    else if (e.key === "Enter" && onOpenRow) {
      const row = rows[activeIndex];
      if (row) onOpenRow(row.original);
    } else return;
    e.preventDefault();
  };

  const facetValue = (columnId: string) =>
    (columnFilters.find((f) => f.id === columnId)?.value as string | undefined) ?? ALL;
  const setFacet = (columnId: string, value: string) =>
    setColumnFilters((current) => [
      ...current.filter((f) => f.id !== columnId),
      ...(value === ALL ? [] : [{ id: columnId, value }]),
    ]);

  const applyView = (view: SavedView) => {
    setGlobalFilter(view.globalFilter);
    setColumnFilters(view.columnFilters);
    setSorting(view.sorting);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="pl-8"
          />
        </div>
        {facets.map((facet) => (
          <Select key={facet.columnId} value={facetValue(facet.columnId)} onValueChange={(v) => setFacet(facet.columnId, String(v))}>
            <SelectTrigger aria-label={facet.label} className="min-w-36">
              <SelectValue>
                {(value: string) =>
                  value === ALL ? `All ${facet.label.toLowerCase()}` : (facet.options.find((o) => o.value === value)?.label ?? value)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All {facet.label.toLowerCase()}</SelectItem>
              {facet.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setGlobalFilter("");
              setColumnFilters([]);
            }}
          >
            <XIcon />
            Clear
          </Button>
        )}
        <SaveView
          disabled={!filtered}
          onSave={(name) => views.save({ name, globalFilter, columnFilters, sorting })}
        />
      </div>

      {views.list.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Saved views">
          {views.list.map((view) => (
            <span key={view.name} className="inline-flex items-center rounded-full border bg-card text-xs">
              <button
                type="button"
                className="rounded-l-full py-1 pr-1 pl-2.5 font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:scale-[0.97]"
                onClick={() => applyView(view)}
              >
                {view.name}
              </button>
              <button
                type="button"
                aria-label={`Delete view ${view.name}`}
                className="rounded-r-full py-1 pr-2 pl-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                onClick={() => views.remove(view.name)}
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                      className={cn(header.column.columnDef.meta?.align === "end" && "text-right")}
                    >
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "-mx-1 inline-flex items-center gap-1 rounded px-1 font-medium hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                            header.column.columnDef.meta?.align === "end" && "flex-row-reverse",
                          )}
                        >
                          <table.FlexRender header={header} />
                          {sorted === "asc" ? (
                            <ArrowUpIcon className="size-3.5" />
                          ) : sorted === "desc" ? (
                            <ArrowDownIcon className="size-3.5" />
                          ) : null}
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody ref={bodyRef} onKeyDown={onBodyKeyDown}>
            {rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={table.getVisibleLeafColumns().length} className="h-24 text-center text-muted-foreground">
                  {filtered ? "Nothing matches these filters." : emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row, index) => (
                <TableRow
                  key={row.id}
                  data-row
                  tabIndex={index === activeIndex ? 0 : -1}
                  onFocus={() => setActiveIndex(index)}
                  onClick={onOpenRow ? () => onOpenRow(row.original) : undefined}
                  className={cn(
                    "outline-none focus-visible:bg-accent focus-visible:shadow-[inset_2px_0_0_var(--ring)]",
                    onOpenRow && "cursor-pointer",
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn(cell.column.columnDef.meta?.align === "end" && "text-right")}
                    >
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <p className="tabular text-xs text-muted-foreground" aria-live="polite">
        {rows.length === data.length ? `${data.length} rows` : `${rows.length} of ${data.length} rows`}
      </p>
    </div>
  );
}

function SaveView({ disabled, onSave }: { disabled: boolean; onSave: (name: string) => void }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  if (!naming) {
    return (
      <Button variant="outline" disabled={disabled} onClick={() => setNaming(true)}>
        <BookmarkIcon />
        Save view
      </Button>
    );
  }
  const commit = () => {
    if (name.trim()) onSave(name.trim());
    setName("");
    setNaming(false);
  };
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
    >
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setNaming(false)}
        placeholder="View name"
        aria-label="View name"
        className="w-40"
      />
      <Button type="submit" variant="secondary">
        Save
      </Button>
    </form>
  );
}

/** Saved views in localStorage: per viewer, optional, and safe when storage is blocked. */
function useSavedViews(key: string) {
  const storageKey = `flowless-views:${key}`;
  const read = (): string => {
    try {
      return localStorage.getItem(storageKey) ?? "[]";
    } catch {
      return "[]";
    }
  };
  const raw = useSyncExternalStore(subscribeViews, read, () => "[]");
  const list = parseViews(raw);
  const write = (next: SavedView[]) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Storage blocked: views simply are not kept.
    }
    viewListeners.forEach((notify) => notify());
  };
  return {
    list,
    save: (view: SavedView) => write([...list.filter((v) => v.name !== view.name), view]),
    remove: (name: string) => write(list.filter((v) => v.name !== name)),
  };
}

const viewListeners = new Set<() => void>();
function subscribeViews(onChange: () => void) {
  viewListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    viewListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function parseViews(raw: string): SavedView[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedView[]) : [];
  } catch {
    return [];
  }
}
