import { useRouter } from "expo-router";
import { ChevronLeft, Search, X, type LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text as RNText,
  TextInput as RNTextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets, type Edge } from "react-native-safe-area-context";
import { CONDITION_HEX, CONDITION_LABEL } from "../lib/format";
import { radius, TOUCH, type, useTheme, type Palette } from "../lib/theme";
import type { Tone } from "../lib/work-orders";
import type { AssetCondition } from "@flowless/shared-types";

/*
 * The app's building blocks, styled from the web's design tokens (lib/theme.ts). Everything that
 * can be tapped is at least 44 points tall (TOUCH), and every colour comes from the palette, so
 * light and dark both work without per-screen branching.
 */

type TextTone = "default" | "muted" | "faint" | "primary" | "success" | "warning" | "danger" | "inverse";
const toneColor = (c: Palette, tone: TextTone) =>
  ({ default: c.foreground, muted: c.mutedForeground, faint: c.input, primary: c.primary, success: c.success, warning: c.warning, danger: c.destructive, inverse: c.primaryForeground })[tone];

/** `v` picks a step of the type scale (lib/theme.ts `type`), `tone` a colour, `bold` a heavier weight. */
export function Text({ v = "body", tone = "default", bold, style, ...props }: TextProps & { v?: keyof typeof type; tone?: TextTone; bold?: boolean }) {
  const { c } = useTheme();
  return <RNText {...props} style={[type[v], { color: toneColor(c, tone) }, bold && { fontWeight: "600" }, style]} />;
}

export function TextInput({ style, ...props }: TextInputProps) {
  const { c } = useTheme();
  return <RNTextInput placeholderTextColor={c.input} {...props} style={[type.body, { color: c.foreground }, style]} />;
}

export function Screen({ children, edges = ["top"] }: { children: ReactNode; edges?: Edge[] }) {
  const insets = useSafeAreaInsets();
  const { c } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: c.background, paddingTop: edges.includes("top") ? insets.top : 0, paddingBottom: edges.includes("bottom") ? insets.bottom : 0 }}>
      {children}
    </View>
  );
}

/** Header for stack screens: always a back key, per the navigation model. */
export function Header({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  const router = useRouter();
  const { c } = useTheme();
  return (
    <View style={s.header}>
      <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back" style={({ pressed }) => [s.iconBtn, pressed && { backgroundColor: c.accent }]}>
        <ChevronLeft size={26} color={c.foreground} />
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text v="title" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text v="small" tone="muted" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  return <View style={[{ borderRadius: radius["2xl"], borderWidth: StyleSheet.hairlineWidth * 2, borderColor: c.border, backgroundColor: c.card }, style]}>{children}</View>;
}

export function Divider() {
  const { c } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />;
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <View style={s.sectionHeader}>
      <Text v="lead" bold>
        {title}
      </Text>
      {action ? (
        <Pressable onPress={onAction} hitSlop={10} accessibilityRole="button" style={{ minHeight: TOUCH, justifyContent: "center" }}>
          <Text v="small" tone="primary" bold>
            {action}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A list row you can tap: 44 points minimum, a fill while pressed. */
export function Row({ children, onPress, style, accessibilityLabel }: { children: ReactNode; onPress?: () => void; style?: StyleProp<ViewStyle>; accessibilityLabel?: string }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [{ minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 }, pressed && { backgroundColor: c.accent }, style]}
    >
      {children}
    </Pressable>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  label,
  onPress,
  variant = "primary",
  icon: Icon,
  loading,
  disabled,
  compact,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  icon?: LucideIcon;
  loading?: boolean;
  disabled?: boolean;
  /** 44 points instead of 52, for buttons inside rows. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { c } = useTheme();
  const look = {
    primary: { bg: c.primary, fg: c.primaryForeground, border: c.primary },
    danger: { bg: c.destructive, fg: "#FFFFFF", border: c.destructive },
    secondary: { bg: c.card, fg: c.foreground, border: c.input },
    ghost: { bg: "transparent", fg: c.primary, border: "transparent" },
  }[variant];
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      style={({ pressed }) => [
        { minHeight: compact ? TOUCH : 52, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: radius.xl, borderWidth: 1, paddingHorizontal: compact ? 14 : 20, backgroundColor: look.bg, borderColor: look.border },
        pressed && { opacity: 0.75 },
        off && { opacity: 0.4 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={look.fg} /> : Icon ? <Icon size={20} color={look.fg} /> : null}
      <Text v="body" bold style={{ color: look.fg }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Chip({ label, active, onPress, dot }: { label: string; active?: boolean; onPress?: () => void; dot?: string }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      style={({ pressed }) => [
        { minHeight: TOUCH, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radius.full, borderWidth: 1, paddingHorizontal: 16, borderColor: active ? c.primary : c.input, backgroundColor: active ? c.primary : c.card },
        pressed && { opacity: 0.75 },
      ]}
    >
      {dot ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} /> : null}
      <Text v="small" bold style={{ color: active ? c.primaryForeground : c.foreground }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ConditionBadge({ condition }: { condition: AssetCondition }) {
  const { c } = useTheme();
  return (
    <View style={[s.badge, { backgroundColor: c.muted }]}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: CONDITION_HEX[condition] }} />
      <Text v="caption" bold>
        {CONDITION_LABEL[condition]}
      </Text>
    </View>
  );
}

export const toneColors = (c: Palette, tone: Tone) =>
  ({
    neutral: { bg: c.muted, fg: c.mutedForeground },
    info: { bg: c.infoSoft, fg: c.info },
    ok: { bg: c.successSoft, fg: c.success },
    warn: { bg: c.warningSoft, fg: c.warning },
    danger: { bg: c.destructiveSoft, fg: c.destructive },
  })[tone];

export function StatusPill({ label, tone = "neutral", icon: Icon, onPress }: { label: string; tone?: Tone; icon?: LucideIcon; onPress?: () => void }) {
  const { c } = useTheme();
  const t = toneColors(c, tone);
  const body = (
    <View style={[s.badge, { backgroundColor: t.bg, alignSelf: "flex-start", paddingVertical: 6 }]}>
      {Icon ? <Icon size={14} color={t.fg} /> : null}
      <Text v="caption" bold style={{ color: t.fg }}>
        {label}
      </Text>
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button" hitSlop={8}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

/** A boxed message: an error, a warning, a note. */
export function Notice({ tone = "info", icon: Icon, children }: { tone?: Tone; icon?: LucideIcon; children: ReactNode }) {
  const { c } = useTheme();
  const t = toneColors(c, tone);
  return (
    <View style={{ flexDirection: "row", gap: 10, borderRadius: radius.xl, padding: 14, backgroundColor: t.bg }}>
      {Icon ? <Icon size={18} color={t.fg} style={{ marginTop: 2 }} /> : null}
      <View style={{ flex: 1, gap: 2 }}>{typeof children === "string" ? <Text v="small" style={{ color: t.fg }}>{children}</Text> : children}</View>
    </View>
  );
}

export function Field({ label, hint, error, style, ...props }: { label?: string; hint?: string; error?: string } & TextInputProps) {
  const { c } = useTheme();
  return (
    <View style={[{ gap: 6 }, style as StyleProp<ViewStyle>]}>
      {label ? (
        <Text v="small" bold>
          {label}
        </Text>
      ) : null}
      <TextInput
        {...props}
        style={[
          { borderRadius: radius.xl, borderWidth: 1, backgroundColor: c.card, paddingHorizontal: 16, borderColor: error ? c.destructive : c.input },
          props.multiline ? { minHeight: 112, paddingTop: 12, paddingBottom: 12, textAlignVertical: "top" } : { minHeight: 52 },
        ]}
      />
      {error ? (
        <Text v="small" tone="danger">
          {error}
        </Text>
      ) : hint ? (
        <Text v="small" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: "row", borderRadius: radius.xl, backgroundColor: c.muted, padding: 4 }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={{ minHeight: TOUCH, flex: 1, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: active ? c.card : "transparent" }}
          >
            <Text v="small" bold tone={active ? "default" : "muted"}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function EmptyState({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body?: string }) {
  const { c } = useTheme();
  return (
    <View style={{ alignItems: "center", gap: 8, paddingHorizontal: 32, paddingVertical: 48 }}>
      <View style={{ width: 56, height: 56, alignItems: "center", justifyContent: "center", borderRadius: 28, backgroundColor: c.muted }}>
        <Icon size={26} color={c.mutedForeground} />
      </View>
      <Text v="body" bold>
        {title}
      </Text>
      {body ? (
        <Text v="small" tone="muted" style={{ textAlign: "center" }}>
          {body}
        </Text>
      ) : null}
    </View>
  );
}

export function SearchField({ value, onChangeText, placeholder }: { value: string; onChangeText: (v: string) => void; placeholder: string }) {
  const { c } = useTheme();
  return (
    <View style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radius["2xl"], borderWidth: 1, borderColor: c.input, backgroundColor: c.card, paddingHorizontal: 14 }}>
      <Search size={18} color={c.mutedForeground} />
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} autoCorrect={false} returnKeyType="search" style={{ flex: 1, minHeight: 44 }} />
      {value !== "" && (
        <Pressable onPress={() => onChangeText("")} hitSlop={12} accessibilityRole="button" accessibilityLabel="Clear search" style={{ minHeight: TOUCH, minWidth: 24, justifyContent: "center" }}>
          <X size={18} color={c.mutedForeground} />
        </Pressable>
      )}
    </View>
  );
}

/** Sticky bottom bar for primary actions on form screens. */
export function Footer({ children }: { children: ReactNode }) {
  const { c } = useTheme();
  return <View style={{ gap: 8, borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: c.border, backgroundColor: c.card, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 }}>{children}</View>;
}

/** The line under a primary button: what is stopping it, or what will happen. */
export function Hint({ issue, children }: { issue?: string | null; children?: ReactNode }) {
  return (
    <Text v="small" tone={issue ? "warning" : "faint"} style={{ textAlign: "center", paddingBottom: 4 }}>
      {issue ?? children}
    </Text>
  );
}

export function Label({ children }: { children: string }) {
  return (
    <Text v="small" bold>
      {children}
    </Text>
  );
}

/** Round, 44 point icon button for map controls and headers. */
export function IconButton({ icon: Icon, label, onPress, active, style }: { icon: LucideIcon; label: string; onPress: () => void; active?: boolean; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: 24, borderWidth: 1, borderColor: active ? c.primary : c.border, backgroundColor: active ? c.primary : c.card, shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
        pressed && { opacity: 0.75 },
        style,
      ]}
    >
      <Icon size={20} color={active ? c.primaryForeground : c.foreground} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  header: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, paddingVertical: 8 },
  iconBtn: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: 24 },
  sectionHeader: { marginTop: 24, marginBottom: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4 },
  badge: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4 },
});
