import { DropletsIcon } from "lucide-react";
import { SignInForm } from "./sign-in-form";

export const metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <DropletsIcon className="size-5" />
          </span>
          <h1 className="text-2xl font-semibold">Sign in to Flowless</h1>
          <p className="text-sm text-muted-foreground">Use your work email. You choose the organization after signing in.</p>
        </div>
        <SignInForm />
      </div>
    </main>
  );
}
