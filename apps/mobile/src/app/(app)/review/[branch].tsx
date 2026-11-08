import { useLocalSearchParams, useRouter } from "expo-router";
import { ArrowRight, Box, ChevronDown, CircleCheck, Hexagon, MapPin, Plug, Route as RouteIcon, SearchX, Trash2, TriangleAlert, type LucideIcon } from "lucide-react-native";
import { useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { Button, Card, Divider, EmptyState, Footer, Header, Notice, Screen, SectionHeader, StatusPill, Text } from "../../../components/ui";
import {
  awaitingApproval,
  conflictsOf,
  EXISTENCE_FIELD,
  fieldLabel,
  formatRange,
  formatValue,
  MODE_LABEL,
  ORIGIN_LABEL,
  SKIP_LABEL,
  type EntityType,
  type FieldConflict,
  type Resolutions,
  type ReviewEntity,
} from "../../../lib/review";
import { radius, TOUCH, useTheme } from "../../../lib/theme";
import type { PostResult } from "../../../lib/types";
import { personName } from "../../../lib/work-orders";
import { useReview, useSession } from "../../../state/app";

const ENTITY_ICON: Record<EntityType, LucideIcon> = { node: MapPin, structure: Box, pipe: RouteIcon, connection: Plug, dma: Hexagon };

type Outcome = PostResult | { status: "failed"; message: string };

function Option({ selected, title, value, hint, onPress }: { selected: boolean; title: string; value: string; hint?: string; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radius["2xl"], borderWidth: 2, padding: 14, borderColor: selected ? c.primary : c.border, backgroundColor: selected ? c.accent : c.card }}
    >
      <View style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 12, borderWidth: 2, borderColor: selected ? c.primary : c.input }}>
        {selected && <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: c.primary }} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text v="small" tone="muted">
          {title}
        </Text>
        <Text v="lead" bold>
          {value}
        </Text>
        {hint ? (
          <Text v="small" tone="muted">
            {hint}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function ConflictCard({ entity, resolutions, onPick }: { entity: ReviewEntity; resolutions: Resolutions; onPick: (field: string, side: "branch" | "main") => void }) {
  const Icon = ENTITY_ICON[entity.entityType];
  const { c } = useTheme();
  const describe = (cf: FieldConflict) => {
    if (cf.field === EXISTENCE_FIELD) {
      const deleted = cf.branch === "deleted";
      return {
        title: "Whether it exists",
        branchValue: deleted ? "Delete it" : "Restore it",
        branchHint: deleted ? "The technician removed it." : "The technician edited it.",
        mainValue: deleted ? "Keep it" : "Keep it deleted",
        mainHint: deleted ? "It was edited on the live network since." : "It was deleted on the live network since.",
        base: undefined as string | undefined,
      };
    }
    return {
      title: fieldLabel(cf.field),
      branchValue: formatValue(cf.field, cf.branch),
      branchHint: undefined,
      mainValue: formatValue(cf.field, cf.main),
      mainHint: undefined,
      base: `Originally ${formatValue(cf.field, cf.base)}`,
    };
  };
  return (
    <Card style={{ gap: 16, padding: 16 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Icon size={20} color={c.primary} />
        <Text bold numberOfLines={1} style={{ flex: 1 }}>
          {entity.name}
        </Text>
      </View>
      {conflictsOf(entity).map((cf) => {
        const d = describe(cf);
        const picked = resolutions[entity.id]?.[cf.field];
        return (
          <View key={cf.field} style={{ gap: 8 }}>
            <Text v="small" bold>
              {d.title}
              {d.base ? ` · ${d.base}` : ""}
            </Text>
            <Option selected={picked === "branch"} title="Technician's change" value={d.branchValue} hint={d.branchHint} onPress={() => onPick(cf.field, "branch")} />
            <Option selected={picked === "main"} title="Live network now" value={d.mainValue} hint={d.mainHint} onPress={() => onPick(cf.field, "main")} />
          </View>
        );
      })}
    </Card>
  );
}

function ChangeRow({ entity }: { entity: ReviewEntity }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const Icon = ENTITY_ICON[entity.entityType];
  if (entity.plan.kind !== "write") return null;
  const { mode, changes } = entity.plan;
  const expandable = changes.length > 0;
  return (
    <View>
      <Pressable
        onPress={() => expandable && setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [{ minHeight: 68, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 }, pressed && { backgroundColor: c.accent }]}
      >
        <Icon size={20} color={c.mutedForeground} />
        <View style={{ flex: 1 }}>
          <Text bold numberOfLines={1}>
            {entity.name}
          </Text>
          <Text v="small" tone="muted">
            {MODE_LABEL[mode]}
            {expandable ? ` · ${changes.length} field${changes.length === 1 ? "" : "s"}` : ""}
            {entity.needsPhoto ? " · Needs a photo" : ""}
          </Text>
        </View>
        {mode === "delete" && <StatusPill label="Removes" tone="danger" />}
        {expandable && (
          <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
            <ChevronDown size={20} color={c.input} />
          </View>
        )}
      </Pressable>
      {open && (
        <View style={{ gap: 10, paddingHorizontal: 16, paddingBottom: 16 }}>
          {changes.map((ch) => (
            <View key={ch.field} style={{ gap: 2 }}>
              <Text v="small" tone="muted">
                {fieldLabel(ch.field)}
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                {mode !== "create" && (
                  <>
                    <Text tone="faint">{formatValue(ch.field, ch.from)}</Text>
                    <ArrowRight size={16} color={c.input} />
                  </>
                )}
                <Text bold>{formatValue(ch.field, ch.to)}</Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export default function ReviewBranchScreen() {
  const { branch: name } = useLocalSearchParams<{ branch: string }>();
  const router = useRouter();
  const { c } = useTheme();
  const { user, abilities } = useSession();
  const { branches, postBranch, discardBranch } = useReview();
  const [override, setOverride] = useState(false);
  // Posting removes the branch from the list, so keep what we're looking at.
  const [snapshot] = useState(() => branches.find((b) => b.branch === name));
  const [resolutions, setResolutions] = useState<Resolutions>({});
  const [posting, setPosting] = useState(false);
  const [result, setResult] = useState<Outcome | null>(null);

  if (!snapshot) {
    return (
      <Screen edges={["top", "bottom"]}>
        <Header title="Review changes" />
        <EmptyState icon={SearchX} title="Not found" body="This set of changes was already posted or discarded." />
      </Screen>
    );
  }

  const author = snapshot.authorIds.map((id) => personName(id, user.id)).join(", ") || "A teammate";
  const reviewer = abilities.post;
  const gated = awaitingApproval(snapshot) && !override;
  const conflicts = snapshot.entities.filter((e) => e.plan.kind === "conflict");
  const writes = snapshot.entities.filter((e) => e.plan.kind === "write");
  const skips = snapshot.entities.filter((e) => e.plan.kind === "skip");
  const totalFields = conflicts.reduce((n, e) => n + conflictsOf(e).length, 0);
  const decided = conflicts.reduce((n, e) => n + conflictsOf(e).filter((cf) => resolutions[e.id]?.[cf.field]).length, 0);
  const undecided = totalFields - decided;
  const willPost = writes.length + conflicts.filter((e) => conflictsOf(e).every((cf) => resolutions[e.id]?.[cf.field])).length;
  const pick = (entityId: string) => (field: string, side: "branch" | "main") => setResolutions((r) => ({ ...r, [entityId]: { ...r[entityId], [field]: side } }));

  async function doPost() {
    setPosting(true);
    const res = await postBranch(snapshot!.branch, resolutions, override);
    setPosting(false);
    setResult(res);
  }
  function confirmPost() {
    Alert.alert(`Post ${willPost} change${willPost === 1 ? "" : "s"} to the live network?`, "Everyone sees them straight away. If anything fails, nothing is posted.", [
      { text: "Cancel", style: "cancel" },
      { text: "Post", onPress: doPost },
    ]);
  }
  function confirmDiscard() {
    Alert.alert("Discard these changes?", "The technician's edits stop being proposals. The live network isn't touched.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: async () => {
          await discardBranch(snapshot!.branch);
          router.back();
        },
      },
    ]);
  }

  /* ---------- outcome views ---------- */

  if (result?.status === "posted") {
    const s = result.summary;
    const lines: [string, number][] = [["Added", s.created], ["Updated", s.fastForwarded + s.merged], ["Deleted", s.deleted], ["Restored", s.restored], ["Left as they were", s.skipped]];
    return (
      <Screen edges={["top", "bottom"]}>
        <Header title="Posted" subtitle={snapshot.origin ? `${snapshot.origin.ref} · ${ORIGIN_LABEL[snapshot.origin.status] ?? snapshot.origin.status}` : formatRange(snapshot.firstEditAt, snapshot.lastEditAt)} />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16, paddingHorizontal: 24 }}>
          <View style={{ width: 80, height: 80, alignItems: "center", justifyContent: "center", borderRadius: 40, backgroundColor: c.successSoft }}>
            <CircleCheck size={40} color={c.success} />
          </View>
          <Text v="title" style={{ textAlign: "center" }}>
            Posted to the live network
          </Text>
          <Card style={{ width: "100%", overflow: "hidden" }}>
            {lines
              .filter(([, n]) => n > 0)
              .map(([label, n], i) => (
                <View key={label}>
                  {i > 0 && <Divider />}
                  <View style={{ minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16 }}>
                    <Text tone="muted">{label}</Text>
                    <Text bold>{n}</Text>
                  </View>
                </View>
              ))}
          </Card>
        </View>
        <Footer>
          <Button label="Back to review" onPress={() => router.back()} />
        </Footer>
      </Screen>
    );
  }

  if (result?.status === "invalid") {
    return (
      <Screen edges={["top", "bottom"]}>
        <Header title="Couldn't post" />
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 12 }}>
          <Notice tone="danger" icon={TriangleAlert}>
            <Text bold style={{ color: c.destructive }}>
              Nothing was changed
            </Text>
            <Text v="small" style={{ color: c.destructive }}>
              Posting these would leave the live network inconsistent:
            </Text>
          </Notice>
          <Card style={{ overflow: "hidden" }}>
            {result.violations.map((v, i) => (
              <View key={`${v.entityId}-${i}`}>
                {i > 0 && <Divider />}
                <Text style={{ padding: 16 }}>{v.message}</Text>
              </View>
            ))}
          </Card>
          <Text v="small" tone="muted" style={{ paddingHorizontal: 4 }}>
            Ask {author} to fix it, or discard this set of changes.
          </Text>
        </ScrollView>
        <Footer>
          <Button label="Back to the changes" onPress={() => setResult(null)} />
          {reviewer && <Button label="Discard these changes" variant="ghost" icon={Trash2} onPress={confirmDiscard} />}
        </Footer>
      </Screen>
    );
  }

  const stopped =
    result?.status === "failed"
      ? result.message
      : result?.status === "conflicts"
        ? "The live network changed while you were deciding. Go back and review the changes again."
        : result?.status === "not_approved"
          ? `${result.origin.ref} hasn't been approved yet.`
          : null;

  /* ---------- main view ---------- */

  return (
    <Screen edges={["top", "bottom"]}>
      <Header title={author} subtitle={formatRange(snapshot.firstEditAt, snapshot.lastEditAt)} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        {stopped && <Notice tone="warn" icon={TriangleAlert}>{stopped}</Notice>}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 4, paddingTop: stopped ? 12 : 0 }}>
          <StatusPill label={`${willPost} ready`} tone="ok" />
          {undecided > 0 && <StatusPill label={`${undecided} to decide`} tone="warn" />}
          {skips.length > 0 && <StatusPill label={`${skips.length} unchanged`} tone="neutral" />}
          {snapshot.origin && <StatusPill label={`${snapshot.origin.ref} · ${ORIGIN_LABEL[snapshot.origin.status] ?? snapshot.origin.status}`} tone={snapshot.origin.status === "completed" ? "ok" : "info"} />}
        </View>

        {conflicts.length > 0 && (
          <>
            <SectionHeader title="Needs your decision" />
            <Text v="small" tone="muted" style={{ marginBottom: 12, paddingHorizontal: 4 }}>
              The live network changed after the technician started. Choose which version to keep.
            </Text>
            <View style={{ gap: 12 }}>
              {conflicts.map((e) => (
                <ConflictCard key={e.id} entity={e} resolutions={resolutions} onPick={reviewer ? pick(e.id) : () => {}} />
              ))}
            </View>
          </>
        )}

        {writes.length > 0 && (
          <>
            <SectionHeader title="Changes" />
            <Card style={{ overflow: "hidden" }}>
              {writes.map((e, i) => (
                <View key={e.id}>
                  {i > 0 && <Divider />}
                  <ChangeRow entity={e} />
                </View>
              ))}
            </Card>
          </>
        )}

        {skips.length > 0 && (
          <>
            <SectionHeader title="No change needed" />
            <Card style={{ overflow: "hidden" }}>
              {skips.map((e, i) => (
                <View key={e.id}>
                  {i > 0 && <Divider />}
                  <View style={{ minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 16, paddingVertical: 12 }}>
                    <Text numberOfLines={1} tone="muted" style={{ flex: 1 }}>
                      {e.name}
                    </Text>
                    <Text v="small" tone="faint">
                      {e.plan.kind === "skip" ? SKIP_LABEL[e.plan.reason] : ""}
                    </Text>
                  </View>
                </View>
              ))}
            </Card>
          </>
        )}
        <View style={{ height: TOUCH }} />
      </ScrollView>

      {reviewer ? (
        <Footer>
          <Button label={`Post ${willPost} change${willPost === 1 ? "" : "s"}`} loading={posting} disabled={undecided > 0 || gated} onPress={confirmPost} />
          <Text v="small" tone={gated || undecided > 0 ? "warning" : "faint"} style={{ textAlign: "center" }}>
            {gated ? `${snapshot.origin!.ref} hasn't been approved yet.` : undecided > 0 ? `Decide ${undecided} conflict${undecided === 1 ? "" : "s"} first` : "All or nothing: if anything fails, nothing is posted."}
          </Text>
          {gated && (
            <Button
              label="Post anyway"
              variant="ghost"
              compact
              onPress={() =>
                Alert.alert("Post before approval?", "The work on this job hasn't been approved. Only do this if you've checked it yourself.", [
                  { text: "Cancel", style: "cancel" },
                  { text: "Post anyway", onPress: () => setOverride(true) },
                ])
              }
            />
          )}
          <Button label="Discard these changes" variant="ghost" icon={Trash2} compact onPress={confirmDiscard} />
        </Footer>
      ) : (
        <Footer>
          <Text v="small" tone="muted" style={{ textAlign: "center", paddingBottom: 4 }}>
            An engineer will review these. You&apos;ll see them on the map once approved.
          </Text>
        </Footer>
      )}
    </Screen>
  );
}
