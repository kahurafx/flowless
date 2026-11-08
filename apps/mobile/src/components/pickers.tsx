import { useMemo, useState } from "react";
import { View } from "react-native";
import { PIPE_SIZES_MM } from "../lib/format";
import type { AppNode } from "../lib/types";
import { Chip, Field, Label, SearchField, Text } from "./ui";

/** A numeric field with common sizes underneath for one-tap entry. */
export function SizeField({ label, value, onChange, below }: { label: string; value: string; onChange: (v: string) => void; below?: number }) {
  const sizes = below ? PIPE_SIZES_MM.filter((s) => s < below) : PIPE_SIZES_MM;
  const n = Number(value);
  return (
    <View style={{ gap: 8 }}>
      <Field label={label} value={value} onChangeText={onChange} keyboardType="numeric" placeholder="e.g. 200" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {sizes.map((s) => (
          <Chip key={s} label={`${s}`} active={n === s} onPress={() => onChange(String(s))} />
        ))}
      </View>
    </View>
  );
}

/** Search the network's nodes by name or id and pick one. Shows a few matches at a time, so the list stays short on a phone. */
export function NodePicker({ label, nodes, value, onChange, error }: { label: string; nodes: readonly AppNode[]; value: string | null; onChange: (id: string) => void; error?: string }) {
  const [query, setQuery] = useState("");
  const picked = nodes.find((n) => n.id === value);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return nodes.filter((n) => !q || n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).slice(0, 5);
  }, [nodes, query]);
  return (
    <View style={{ gap: 8 }}>
      <Label>{label}</Label>
      <SearchField value={query} onChangeText={setQuery} placeholder="Search by name or ID" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {picked && !matches.some((n) => n.id === picked.id) && <Chip label={picked.name} active onPress={() => onChange(picked.id)} />}
        {matches.map((n) => (
          <Chip key={n.id} label={n.name} active={value === n.id} onPress={() => onChange(n.id)} />
        ))}
      </View>
      {error ? (
        <Text v="small" tone="danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
