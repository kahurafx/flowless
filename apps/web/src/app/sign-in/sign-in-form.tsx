"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

/**
 * Email and password, then a TOTP code when the user has two-factor on (NF-05).
 * Errors show inline, next to the form, in plain language.
 */
export function SignInForm() {
  const router = useRouter();
  const [step, setStep] = useState<"password" | "totp">("password");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const finish = () => {
    // The staff layout sends users without an active organization to the picker.
    router.push("/");
    router.refresh();
  };

  const onPassword = (form: FormData) =>
    startTransition(async () => {
      setError(null);
      const { data, error } = await authClient.signIn.email({
        email: String(form.get("email")),
        password: String(form.get("password")),
      });
      if (error) {
        setError(error.status === 429 ? "Too many attempts. Wait a minute and try again." : "Email or password is incorrect.");
        return;
      }
      if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) setStep("totp");
      else finish();
    });

  const onTotp = (form: FormData) =>
    startTransition(async () => {
      setError(null);
      const { error } = await authClient.twoFactor.verifyTotp({ code: String(form.get("code")) });
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
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="code">Authenticator code</Label>
          <Input
            id="code"
            name="code"
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
