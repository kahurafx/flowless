import { useLocalSearchParams, useRouter } from "expo-router";
import { CircleCheck, ClipboardCheck, ClipboardList, SearchX } from "lucide-react-native";
import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { Card, Divider, EmptyState, Header, Screen, SearchField, Segmented } from "../../components/ui";
import { WorkOrderRow } from "../../components/work-order-row";
import { sortKey } from "../../lib/format";
import { useLocation } from "../../lib/location";
import { usePullToRefresh } from "../../lib/refresh";
import { matchesOrder, rankOrders } from "../../lib/work-orders";
import { useJobs, useNetwork, useSession } from "../../state/app";

type Tab = "todo" | "approval" | "done";

export default function WorkOrdersScreen() {
  const refreshControl = usePullToRefresh();
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: Tab }>();
  const { user, abilities } = useSession();
  const { myOrders, approvals } = useJobs();
  const { nodes } = useNetwork();
  const { point } = useLocation();
  const [tab, setTab] = useState<Tab>(params.tab === "approval" && abilities.review ? "approval" : "todo");
  const [query, setQuery] = useState("");

  const ranked = useMemo(() => rankOrders(myOrders.filter((o) => matchesOrder(o, query)), nodes, point), [myOrders, query, nodes, point]);
  const open = ranked.filter((r) => r.order.status !== "completed");
  const done = ranked.filter((r) => r.order.status === "completed").sort((a, b) => sortKey(b.order.completion?.at) - sortKey(a.order.completion?.at));
  const queue = useMemo(() => rankOrders(approvals.filter((o) => matchesOrder(o, query)), nodes, point), [approvals, query, nodes, point]);

  const shown = tab === "todo" ? open : tab === "approval" ? queue : done;
  const searching = query.trim() !== "";
  const open_ = (id: string) => router.push({ pathname: "/work-order/[id]", params: { id } });

  return (
    <Screen edges={["top", "bottom"]}>
      <Header title="Work orders" />
      <View style={{ gap: 12, paddingHorizontal: 16, paddingBottom: 8 }}>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search title, code, place or asset" />
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "todo", label: `To do · ${open.length}` },
            ...(abilities.review ? [{ value: "approval" as const, label: `Approval · ${queue.length}` }] : []),
            { value: "done", label: `Done · ${done.length}` },
          ]}
        />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} refreshControl={refreshControl} showsVerticalScrollIndicator={false}>
        {shown.length === 0 ? (
          searching ? (
            <EmptyState icon={SearchX} title="No jobs match" body="Try a different title, code, place or asset." />
          ) : tab === "todo" ? (
            <EmptyState icon={ClipboardList} title="No jobs to do" body="Jobs assigned to you appear here." />
          ) : tab === "approval" ? (
            <EmptyState icon={ClipboardCheck} title="Nothing to approve" body="Work your team sends in for approval appears here." />
          ) : (
            <EmptyState icon={CircleCheck} title="Nothing finished lately" />
          )
        ) : (
          <Card style={{ overflow: "hidden" }}>
            {shown.map((item, i) => (
              <View key={item.order.id}>
                {i > 0 && <Divider />}
                <WorkOrderRow item={item} me={user.id} showWho={tab === "approval"} onPress={() => open_(item.order.id)} />
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}
