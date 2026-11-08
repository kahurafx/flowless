import { Camera, Image as ImageIcon, X } from "lucide-react-native";
import { useState } from "react";
import { Image, Linking, Pressable, View } from "react-native";
import { choosePhotos, MAX_PHOTOS, removeLocal, takePhoto, type PickResult } from "../lib/attachments";
import { useLocation } from "../lib/location";
import { toGeoPoint } from "../lib/work-orders";
import type { LocalFile } from "../lib/types";
import { Button, StatusPill, Text } from "./ui";

/**
 * Photos, from the camera or the gallery (K-08). A photo taken here is geotagged with the phone's last
 * GPS fix (W-02). `required` is how many the screen needs (0 for optional); the screen decides what to
 * do about it, this only shows the count.
 */
export function AttachmentPicker({ items, onChange, required = 0, hint }: { items: LocalFile[]; onChange: (items: LocalFile[]) => void; required?: number; hint?: string }) {
  const { point } = useLocation();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; settings?: boolean } | null>(null);

  async function run(pick: () => Promise<PickResult>) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const res = await pick();
    setBusy(false);
    if (res.ok) {
      onChange([...items, ...res.items]);
      if (res.note) setMessage({ text: res.note });
    } else if (res.reason === "denied") {
      setMessage({ text: "Camera access is off. Allow it in Settings to take photos.", settings: !res.canAskAgain });
    } else if (res.reason === "failed") {
      setMessage({ text: "That didn't work. Try again." });
    }
  }

  function remove(f: LocalFile) {
    removeLocal(f);
    onChange(items.filter((i) => i.id !== f.id));
  }

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text v="small" bold>
          Photos
        </Text>
        <StatusPill label={required > 0 ? `${required} required` : "Optional"} tone={required > 0 ? "warn" : "neutral"} />
        <Text v="small" tone="faint" style={{ marginLeft: "auto" }}>
          {items.length}/{MAX_PHOTOS}
        </Text>
      </View>

      {items.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {items.map((p) => (
            <View key={p.id}>
              <Image source={{ uri: p.uri }} style={{ width: 96, height: 96, borderRadius: 16 }} accessibilityLabel={p.fileName} />
              <Pressable
                onPress={() => remove(p)}
                accessibilityLabel={`Remove ${p.fileName}`}
                hitSlop={10}
                style={{ position: "absolute", right: 4, top: 4, width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: "rgba(15,23,42,0.8)" }}
              >
                <X size={15} color="#fff" />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {items.length < MAX_PHOTOS && (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button label="Take photo" icon={Camera} variant="secondary" compact disabled={busy} onPress={() => run(() => takePhoto(point ? toGeoPoint(point) : undefined))} style={{ flex: 1 }} />
          <Button label="Gallery" icon={ImageIcon} variant="secondary" compact disabled={busy} onPress={() => run(() => choosePhotos(MAX_PHOTOS - items.length))} style={{ flex: 1 }} />
        </View>
      )}
      <Text v="small" tone="faint">
        {hint ?? "A clear photo helps whoever follows up."}
      </Text>

      {message && (
        <View style={{ gap: 4 }}>
          <Text v="small" tone="warning">
            {message.text}
          </Text>
          {message.settings && (
            <Pressable onPress={() => Linking.openSettings()} hitSlop={8} style={{ minHeight: 44, justifyContent: "center" }}>
              <Text v="small" tone="primary" bold>
                Open Settings
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}
