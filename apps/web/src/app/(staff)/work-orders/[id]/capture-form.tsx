"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface Field {
  type?: string;
  maxLength?: number;
}
export interface CaptureSchema {
  properties?: Record<string, Field>;
  required?: string[];
}

const humanize = (key: string) => key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

/** The completion data a kind asks for (W-03), drawn from the kind's JSON Schema. The server checks it again. */
export function CaptureForm({
  schema,
  value,
  onChange,
}: {
  schema: CaptureSchema;
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}) {
  const fields = Object.entries(schema.properties ?? {});
  return (
    <fieldset className="grid gap-3">
      <legend className="text-sm font-medium">What was captured</legend>
      {fields.map(([key, field]) => {
        const required = schema.required?.includes(key) ?? false;
        const id = `capture-${key}`;
        const long = (field.maxLength ?? 0) > 300 || /summary|done|materials|notes?/i.test(key);
        const set = (v: string) => onChange({ ...value, [key]: v });
        return (
          <div key={key} className="grid gap-1.5">
            <Label htmlFor={id}>
              {humanize(key)}
              {required ? "" : " (optional)"}
            </Label>
            {long ? (
              <Textarea id={id} rows={3} value={value[key] ?? ""} onChange={(e) => set(e.target.value)} maxLength={field.maxLength} required={required} />
            ) : (
              <Input id={id} value={value[key] ?? ""} onChange={(e) => set(e.target.value)} maxLength={field.maxLength} required={required} type={field.type === "number" ? "number" : "text"} />
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

/** The captured values as the kind's schema types them (numbers stay numbers), with empty optional fields left out. */
export function captureValue(schema: CaptureSchema, value: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema.properties ?? {}).flatMap(([key, field]) => {
      const raw = (value[key] ?? "").trim();
      if (raw === "" && !(schema.required?.includes(key) ?? false)) return [];
      return [[key, field.type === "number" ? Number(raw) : raw]];
    }),
  );
}
