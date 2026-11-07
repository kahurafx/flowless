"use client";

import {
  isEmailIdentifier,
  normalizeOrganizationCode,
  ORGANIZATION_CODE_HEADER,
  qualifiedUsername,
} from "@flowless/shared-types";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

const CODE_STORAGE_KEY = "flowless-organization-code";
const INVALID = "Organization code, username or password is incorrect.";

/** Last organization code used on this device: a convenience, never trusted. */
function useRememberedCode(): string {
  return useSyncExternalStore(
    () => () => {},
    () => {
      try {
        return localStorage.getItem(CODE_STORAGE_KEY) ?? "";
      } catch {
        return "";
      }
    },
    () => "",
  );
}

/**
 * Organization code, then email (owners and admins) or username (other staff), then
 * password; a TOTP step follows when two-factor is on (NF-05). A user belongs to one
 * organization, so there is nothing to choose after signing in.
 */
export function SignInForm() {
  const router = useRouter();
  const rememberedCode = useRememberedCode();
  const [step, setStep] = useState<"password" | "totp">("password");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const finish = () => {
    router.push("/");
    router.refresh();
  };

  const onPassword = (form: FormData) =>
    startTransition(async () => {
      setError(null);
      const code = normalizeOrganizationCode(String(form.get("code")));
      if (!code) {
        setError("Enter your organization code: letters and digits only, for example MAJISAFI.");
        return;
      }
      const identifier = String(form.get("identifier")).trim();
      const password = String(form.get("password"));
      const fetchOptions = { headers: { [ORGANIZATION_CODE_HEADER]: code } };

      const { data, error } = isEmailIdentifier(identifier)
        ? await authClient.signIn.email({ email: identifier, password, fetchOptions })
        : await authClient.signIn.username({ username: qualifiedUsername(code, identifier), password, fetchOptions });

      if (error) {
        setError(error.status === 429 ? "Too many attempts. Wait a minute and try again." : INVALID);
        return;
      }
      try {
        localStorage.setItem(CODE_STORAGE_KEY, code.toUpperCase());
      } catch {
        // Storage blocked: the code just is not remembered.
      }
      if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) setStep("totp");
      else finish();
    });

  const onTotp = (form: FormData) =>
    startTransition(async () => {
      setError(null);
      const { error } = await authClient.twoFactor.verifyTotp({ code: String(form.get("totp")) });
      if (error) setError("That code did not work. Check your authenticator app and try again.");
      else finish();
    });

  return (
    <form
      action={step === "password" ? onPassword : onTotp}
      className="flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-sm"
      aria-describedby={error ? "sign-in-error" : undefined}
    >
      {step === "password" ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="code">Organization code</Label>
            <Input
              // Remount when the remembered code loads, so it fills the field without a controlled input.
              key={rememberedCode}
              id="code"
              name="code"
              defaultValue={rememberedCode}
              autoComplete="organization"
              autoCapitalize="characters"
              spellCheck={false}
              required
              autoFocus={!rememberedCode}
              className="font-mono uppercase"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="identifier">Username or email</Label>
            <Input
              id="identifier"
              name="identifier"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus={!!rememberedCode}
            />
            <p className="text-xs text-muted-foreground">Administrators use their email. Other staff use their username.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="totp">Authenticator code</Label>
          <Input
            id="totp"
            name="totp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
            className="tabular tracking-widest"
          />
          <p className="text-xs text-muted-foreground">Enter the 6-digit code from your authenticator app.</p>
        </div>
      )}
      {error && (
        <p id="sign-in-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" className="mt-1" disabled={pending}>
        {pending ? "Signing in…" : step === "password" ? "Sign in" : "Verify"}
      </Button>
    </form>
  );
}
