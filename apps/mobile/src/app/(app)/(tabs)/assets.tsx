import type { NodeType } from "@flowless/shared-types";
import { NODE_TYPES } from "@flowless/shared-types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SearchX } from "lucide-react-native";
import { useMemo, useState } from "react";
import { FlatList, ScrollView, View } from "react-native";
import { AssetRow, NODE_TYPE_COLOR } from "../../../components/asset-row";
import { Card, Chip, Divider, EmptyState, Screen, SearchField, Text } from "../../../components/ui";
import { NODE_TYPE_PLURAL } from "../../../lib/format";
import { usePullToRefresh } from "../../../lib/refresh";
import { TAB_SPACE } from "../../../lib/theme";
import { useNetwork } from "../../../state/app";

type Filter = "all" | "attention" | NodeType;

export default function AssetsScreen() {
  const refreshControl = usePullToRefresh();
  const router = useRouter();
  const params = useLocalSearchParams<{ filter?: string }>();
  const { nodes } = useNetwork();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Filter | null>(null);
  // A link from Home ("See all") sets the filter; picking a chip overrides it.
  const filter: Filter = chosen ?? (params.filter === "attention" ? "attention" : "all");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return nodes
      .filter((n) => (filter === "all" ? true : filter === "attention" ? n.condition === "poor" || n.condition === "critical" : n.type === filter))
      .filter((n) => !q || n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [nodes, query, filter]);

  return (
    <Screen>
      <View style={{ gap: 12, paddingHorizontal: 16, paddingBottom: 8, paddingTop: 8 }}>
        <Text v="heading">Assets</Text>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search by name or ID" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 16 }}>
          <Chip label="All" active={filter === "all"} onPress={() => setChosen("all")} />
          <Chip label="Needs attention" active={filter === "attention"} onPress={() => setChosen("attention")} />
          {NODE_TYPES.map((t) => (
            <Chip key={t} label={NODE_TYPE_PLURAL[t]} dot={NODE_TYPE_COLOR[t]} active={filter === t} onPress={() => setChosen(t)} />
          ))}
        </ScrollView>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(n) => n.id}
        refreshControl={refreshControl}
        ItemSeparatorComponent={Divider}
        ListHeaderComponent={
          rows.length > 0 ? (
            <Text v="small" tone="muted" style={{ paddingHorizontal: 20, paddingBottom: 8 }}>
              {rows.length} asset{rows.length === 1 ? "" : "s"}
            </Text>
          ) : undefined
        }
        ListEmptyComponent={<EmptyState icon={SearchX} title="No assets" body={query ? "Try a different name or ID." : "Nothing matches this filter."} />}
        contentContainerStyle={{ paddingBottom: TAB_SPACE + 16 }}
        renderItem={({ item }) => (
          <Card style={{ marginHorizontal: 16, overflow: "hidden", borderRadius: 0 }}>
            <AssetRow node={item} onPress={() => router.push({ pathname: "/asset/[id]", params: { id: item.id } })} />
          </Card>
        )}
      />
    </Screen>
  );
}
