import { useLocalSearchParams, useRouter } from "expo-router";
import { SearchX } from "lucide-react-native";
import { useMemo, useState } from "react";
import { FlatList, View } from "react-native";
import { AssetRow } from "../../components/asset-row";
import { Divider, EmptyState, Header, Screen, SearchField } from "../../components/ui";
import { sortKey } from "../../lib/format";
import { useJobs, useNetwork } from "../../state/app";

/** Step one of "Record inspection" and "Operate valve" when started from Home or the + button, and "Find asset" on a job. */
export default function SelectAsset() {
  const { purpose, workOrderId } = useLocalSearchParams<{ purpose?: "inspect" | "valve" | "job"; workOrderId?: string }>();
  const router = useRouter();
  const { nodes } = useNetwork();
  const { addJobAsset, workOrders } = useJobs();
  const [query, setQuery] = useState("");

  const forJob = purpose === "job";
  const valves = purpose === "valve";
  const job = workOrders.find((o) => o.id === workOrderId);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return nodes
      .filter((n) => (valves ? n.type === "valve" : true))
      .filter((n) => !q || n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
      .filter((n) => !forJob || !job?.assets.some((a) => a.assetId === n.id))
      // Longest since inspection first: what most needs a visit.
      .sort((a, b) => sortKey(a.lastInspectedAt) - sortKey(b.lastInspectedAt));
  }, [nodes, query, valves, forJob, job]);

  return (
    <Screen edges={["top", "bottom"]}>
      <Header title={valves ? "Choose a valve" : forJob ? "Add an asset to the job" : "Choose an asset"} subtitle={valves ? undefined : "Longest since inspection first"} />
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search by name or ID" />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(n) => n.id}
        ItemSeparatorComponent={Divider}
        ListEmptyComponent={<EmptyState icon={SearchX} title="Nothing found" body="Try a different name or ID." />}
        contentContainerStyle={{ paddingBottom: 24 }}
        renderItem={({ item }) => (
          <AssetRow
            node={item}
            onPress={() => {
              if (forJob && workOrderId) {
                addJobAsset(workOrderId, item.id);
                router.back();
                return;
              }
              router.replace({ pathname: valves ? "/valve/[id]" : "/inspect/[id]", params: { id: item.id } });
            }}
          />
        )}
      />
    </Screen>
  );
}
