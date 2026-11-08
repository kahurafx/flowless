"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const NONE = "__none";

/**
 * A single choice from a short list, with an optional "no choice" entry. `value` is "" when
 * nothing is chosen. Labels are looked up from `options` so the trigger shows a name, not an id.
 */
export function FieldSelect({
  id,
  value,
  onChange,
  options,
  placeholder,
  none,
  disabled,
  className,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  placeholder: string;
  /** The label for the empty choice; omit when a choice is required. */
  none?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select value={value === "" ? (none ? NONE : null) : value} onValueChange={(v) => onChange(v === NONE || v === null ? "" : String(v))} disabled={disabled}>
      <SelectTrigger id={id} className={className ?? "w-full"}>
        <SelectValue placeholder={placeholder}>
          {(v: string | null) => (v === null || v === NONE ? (none ?? placeholder) : (options.find((o) => o.value === v)?.label ?? placeholder))}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {none && <SelectItem value={NONE}>{none}</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
