import { useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { AttachmentPicker } from "../../components/attachment-picker";
import { TypeTile } from "../../components/asset-row";
import { LocationCard } from "../../components/location-card";
import { Button, Card, Chip, Field, Footer, Header, Hint, Label, Screen, Text } from "../../components/ui";
import type { LatLng, LocalFile } from "../../lib/types";
import { kindInfo, kindShort } from "../../lib/work-orders";
import { useJobs, useNetwork } from "../../state/app";

/**
 * "Report a problem": a technician raises a job for something they found. The server assigns it to
 * them, always reviewed, source "Field report" (a member who only executes cannot do otherwise), so
 * there is nothing to choose except what and where.
 */
export default function ReportProblem() {
  const router = useRouter();
  const { kinds, raiseJob } = useJobs();
  const { nodes, areas } = useNetwork();
  const raisable = kinds.filter((k) => k.canRaise);
  const [kindKey, setKindKey] = useState<string>(raisable[0]?.key ?? "");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [query, setQuery] = useState("");
  const [assetId, setAssetId] = useState<string | null>(null);
  const [areaId, setAreaId] = useState<string | null>(null);
  const [location, setLocation] = useState<LatLng | null>(null);
  const [placeNote, setPlaceNote] = useState("");
  const [files, setFiles] = useState<LocalFile[]>([]);

  const info = kindInfo(kinds, kindKey);
  const target = info?.target;
  const needsAsset = target === "asset" && info?.gis !== "none" && kindKey !== "leak";
  const takesAsset = target === "asset" || target === "assets";
  const needsLocation = target === "location";
  const needsArea = target === "area";
  const q = query.trim().toLowerCase();
  const matches = q ? nodes.filter((n) => n.name.toLowerCase().includes(q)).slice(0, 4) : [];
  const picked = nodes.find((n) => n.id === assetId);
  const areaMatches = areas.filter((a) => !q || a.name.toLowerCase().includes(q)).slice(0, 6);
  const area = areas.find((a) => a.id === areaId);

  const issue = !info
    ? "Choose what you found"
    : !title.trim()
      ? "Say what you found"
      : needsAsset && !assetId
        ? "Choose the asset"
        : needsArea && !areaId
          ? "Choose the area"
          : needsLocation && !location
            ? "Add the location"
            : !takesAsset && !needsArea && !location && !placeNote.trim()
              ? "Say where it is"
              : takesAsset && !assetId && !location && !placeNote.trim()
                ? "Say where it is"
                : null;

  function save() {
    if (issue || !info) return;
    const id = raiseJob({ title: title.trim(), description: details.trim(), kind: info.key, assetId, areaId, location, locationNote: placeNote.trim() || null, files });
    router.replace({ pathname: "/work-order/[id]", params: { id } });
  }

  return (
    <Screen edges={["top", "bottom"]}>
      <Header title="Report a problem" />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 20 }} keyboardShouldPersistTaps="handled">
          <View style={{ gap: 8 }}>
            <Text bold>What did you find?</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {raisable.map((k) => (
                <Chip
                  key={k.key}
                  label={kindShort(k.key)}
                  active={kindKey === k.key}
                  onPress={() => {
                    setKindKey(k.key);
                    setAssetId(null);
                    setAreaId(null);
                    setQuery("");
                  }}
                />
              ))}
            </View>
            {info && (
              <Text v="small" tone="muted">
                {info.label}
              </Text>
            )}
          </View>

          <Field label="Title" value={title} onChangeText={setTitle} placeholder="e.g. Hydrant leaking at the outlet" maxLength={200} />
          <Field label="Details (optional)" value={details} onChangeText={setDetails} multiline maxLength={2000} placeholder="What did you see? How bad is it?" />

          {takesAsset && (
            <View style={{ gap: 8 }}>
              <Label>{needsAsset ? "Asset" : "Asset (if you know it)"}</Label>
              {picked ? (
                <Card style={{ minHeight: 68, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12 }}>
                  <TypeTile type={picked.type} size={40} />
                  <Text bold numberOfLines={1} style={{ flex: 1 }}>
                    {picked.name}
                  </Text>
                  <Button label="Change" variant="ghost" compact onPress={() => setAssetId(null)} />
                </Card>
              ) : (
                <>
                  <Field value={query} onChangeText={setQuery} placeholder="Search by name or ID" autoCorrect={false} />
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    {matches.map((n) => (
                      <Chip
                        key={n.id}
                        label={n.name}
                        onPress={() => {
                          setAssetId(n.id);
                          setQuery("");
                        }}
                      />
                    ))}
                  </View>
                </>
              )}
            </View>
          )}

          {needsArea && (
            <View style={{ gap: 8 }}>
              <Label>Area</Label>
              {area ? (
                <Card style={{ minHeight: 56, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14 }}>
                  <Text bold style={{ flex: 1 }}>
                    {area.name}
                  </Text>
                  <Button label="Change" variant="ghost" compact onPress={() => setAreaId(null)} />
                </Card>
              ) : (
                <>
                  <Field value={query} onChangeText={setQuery} placeholder="Search areas" autoCorrect={false} />
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    {areaMatches.map((a) => (
                      <Chip
                        key={a.id}
                        label={a.name}
                        onPress={() => {
                          setAreaId(a.id);
                          setQuery("");
                        }}
                      />
                    ))}
                  </View>
                </>
              )}
            </View>
          )}

          {!needsArea && (
            <View style={{ gap: 8 }}>
              <Label>Where is it?</Label>
              <LocationCard value={location} onChange={setLocation} empty={needsLocation ? "Stand at the asset and use your GPS position." : "Use your GPS position, or describe the place."} />
              <Field value={placeNote} onChangeText={setPlaceNote} placeholder="Describe the place, e.g. behind the market" maxLength={300} />
            </View>
          )}

          <AttachmentPicker items={files} onChange={setFiles} hint="A photo helps the supervisor decide how urgent it is." />
          <Text v="small" tone="faint">
            For a burst main, also call the control room. Field reports are queued as normal priority and checked by a supervisor.
          </Text>
        </ScrollView>
        <Footer>
          <Button label="Report it" disabled={!!issue} onPress={save} />
          <Hint issue={issue}>It becomes a job assigned to you.</Hint>
        </Footer>
      </KeyboardAvoidingView>
    </Screen>
  );
}
