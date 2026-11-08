"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

/** What a server action answers: an error to show, or nothing. */
export type Outcome = { error: string | null };

/**
 * A button that opens a small form in a dialog and runs one action. The dialog stays open
 * with the message when the action is refused, closes when it works. `onOpen` runs on
 * each opening (for example to read the device position).
 */
export function ActionDialog({
  label,
  icon,
  variant = "outline",
  title,
  description,
  submitLabel,
  success,
  onSubmit,
  canSubmit = true,
  onOpen,
  children,
  className,
  controlled,
}: {
  label: string;
  icon?: React.ReactNode;
  variant?: "default" | "outline" | "destructive" | "secondary" | "ghost";
  title: string;
  description?: string;
  submitLabel: string;
  success: string;
  onSubmit: () => Promise<Outcome>;
  canSubmit?: boolean;
  onOpen?: () => void;
  children?: React.ReactNode;
  className?: string;
  /** Open it from elsewhere (a click on the map) instead of from its own button. */
  controlled?: { open: boolean; onOpenChange: (open: boolean) => void };
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlled ? controlled.open : ownOpen;
  const setOpen = controlled ? controlled.onOpenChange : setOwnOpen;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = () =>
    startTransition(async () => {
      const result = await onSubmit();
      if (result.error) {
        setError(result.error);
        return;
      }
      toast.success(success);
      setOpen(false);
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setError(null);
          onOpen?.();
        }
      }}
    >
      {!controlled && (
        <DialogTrigger render={<Button variant={variant} className={className} />}>
          {icon}
          {label}
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {children}
          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" variant={variant === "destructive" ? "destructive" : "default"} disabled={pending || !canSubmit}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A device-event answer as an outcome: a refused or stale action carries its reason. */
export function settled(result: { error: string | null; data?: { outcome: string; reason: string | undefined } }): Outcome {
  if (result.error) return { error: result.error };
  const data = result.data;
  if (data && (data.outcome === "rejected" || data.outcome === "stale")) return { error: data.reason ?? "That wasn't possible" };
  return { error: null };
}
