import { DropletsIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const metadata = { title: "Sign in" };

/** Mock sign-in. Phase 1 (A1) posts to Better Auth, with MFA for staff (NF-05). */
async function signIn() {
  "use server";
  redirect("/");
}

export default function SignInPage() {
  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <DropletsIcon className="size-5" />
          </span>
          <h1 className="text-2xl font-semibold">Sign in to Flowless</h1>
          <p className="text-sm text-muted-foreground">Use your work email. Your organization is chosen after sign-in.</p>
        </div>
        <form action={signIn} className="flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="username" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <Button type="submit" size="lg" className="mt-1">
            Sign in
          </Button>
        </form>
        <p className="text-center text-xs text-muted-foreground">Demo build: any credentials work.</p>
      </div>
    </main>
  );
}
