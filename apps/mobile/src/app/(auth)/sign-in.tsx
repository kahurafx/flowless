import { Droplet, Eye, EyeOff, Info } from "lucide-react-native";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { Button, Field, Notice, Screen, Text } from "../../components/ui";
import { readOrgCode } from "../../lib/storage/last-user";
import { TOUCH, useTheme } from "../../lib/theme";
import { useSession } from "../../state/app";

/**
 * Organization code, then an email (owners and admins) or a username (other staff), then the
 * password; a TOTP step follows when two-factor is on (NF-05). A user belongs to one organization, so
 * there is nothing to choose after signing in. Accounts are made by the organization's administrators,
 * so there is no sign-up here.
 */
export default function SignInScreen() {
  const { c } = useTheme();
  const { signIn, verifyTotp, savedOrgCode } = useSession();
  const [orgCode, setOrgCode] = useState(savedOrgCode);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [step, setStep] = useState<"password" | "totp">("password");
  const [totp, setTotp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);

  // The code typed last time on this phone: a convenience, never trusted.
  useEffect(() => {
    if (orgCode) return;
    void readOrgCode().then((code) => code && setOrgCode((current) => current || code));
  }, [orgCode]);

  const ready = step === "password" ? !!orgCode.trim() && !!identifier.trim() && !!password : totp.trim().length === 6;

  async function submit() {
    if (!ready || loading) return;
    setLoading(true);
    setError(null);
    const res = step === "password" ? await signIn({ orgCode, identifier, password }) : await verifyTotp(totp.trim());
    setLoading(false);
    if (res.ok) return;
    if ("needsTotp" in res && res.needsTotp) setStep("totp");
    else setError(res.error);
  }

  return (
    <Screen edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", gap: 20, paddingHorizontal: 24, paddingVertical: 32 }} keyboardShouldPersistTaps="handled">
          <View style={{ alignItems: "center", gap: 12, marginBottom: 8 }}>
            <View style={{ width: 64, height: 64, alignItems: "center", justifyContent: "center", borderRadius: 22, backgroundColor: c.primary }}>
              <Droplet size={32} color={c.primaryForeground} />
            </View>
            <Text v="heading">Flowless</Text>
            <Text tone="muted" style={{ textAlign: "center" }}>
              Field operations for water utilities
            </Text>
          </View>

          {step === "password" ? (
            <>
              <Field
                label="Organization code"
                value={orgCode}
                onChangeText={(t) => setOrgCode(t.toUpperCase())}
                autoCapitalize="characters"
                autoCorrect={false}
                spellCheck={false}
                autoComplete="organization"
                placeholder="e.g. MAJISAFI"
                hint={savedOrgCode ? "Remembered on this phone." : "Ask your administrator if you don't know it."}
                style={{ fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) }}
              />
              <Field
                label="Username or email"
                value={identifier}
                onChangeText={setIdentifier}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                autoComplete="username"
                textContentType="username"
                hint="Administrators use their email. Other staff use their username."
              />
              <View>
                <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry={!show} autoCapitalize="none" autoComplete="current-password" textContentType="password" onSubmitEditing={submit} />
                <Pressable
                  onPress={() => setShow((v) => !v)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={show ? "Hide password" : "Show password"}
                  style={{ position: "absolute", right: 4, top: 22, width: TOUCH + 8, height: 52, alignItems: "center", justifyContent: "center" }}
                >
                  {show ? <EyeOff size={20} color={c.mutedForeground} /> : <Eye size={20} color={c.mutedForeground} />}
                </Pressable>
              </View>
            </>
          ) : (
            <Field
              label="Authenticator code"
              value={totp}
              onChangeText={(t) => setTotp(t.replace(/\D/g, "").slice(0, 6))}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              maxLength={6}
              hint="Enter the 6-digit code from your authenticator app."
              onSubmitEditing={submit}
            />
          )}

          {error && <Notice tone="danger" icon={Info}>{error}</Notice>}

          <Button label={step === "password" ? "Sign in" : "Verify"} onPress={submit} loading={loading} disabled={!ready} />

          <Pressable onPress={() => setHelp((h) => !h)} hitSlop={8} accessibilityRole="button" style={{ minHeight: TOUCH, alignItems: "center", justifyContent: "center" }}>
            <Text v="small" tone="primary" bold>
              Can&apos;t sign in?
            </Text>
          </Pressable>
          {help && (
            <Text v="small" tone="muted" style={{ borderRadius: 14, backgroundColor: c.muted, padding: 12 }}>
              Accounts and password resets are handled by your organization&apos;s administrator. Contact them and they can help you get back in.
            </Text>
          )}

          <Text v="small" tone="faint" style={{ textAlign: "center", paddingHorizontal: 16 }}>
            You&apos;ll stay signed in while offline. Changes you make sync once you&apos;re back online.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
