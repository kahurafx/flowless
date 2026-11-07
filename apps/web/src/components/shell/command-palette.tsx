"use client";

import type { Entitlements } from "@flowless/shared-types";
import { SearchIcon, UserIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { navFor } from "./nav";

/** ⌘K / Ctrl+K: jump anywhere, find an account by number or name (NF-40). */
export function CommandPalette({
  entitlements,
  accounts,
}: {
  entitlements: Entitlements;
  accounts: readonly { number: string; customerName: string }[];
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <>
      <Button
        variant="outline"
        className="w-full max-w-64 justify-start text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        <SearchIcon />
        <span className="truncate">Search accounts…</span>
        <kbd className="ml-auto hidden rounded border px-1 font-mono text-[0.7rem] sm:inline">⌘K</kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Search" description="Jump to a page or account">
        <CommandInput placeholder="Account number, customer or page…" />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          <CommandGroup heading="Go to">
            {navFor(entitlements).map((item) => (
              <CommandItem key={item.href} onSelect={() => go(item.href)}>
                <item.icon />
                {item.label}
              </CommandItem>
            ))}
          </CommandGroup>
          {entitlements.includes("accounts") && (
            <CommandGroup heading="Accounts">
              {accounts.map((a) => (
                <CommandItem
                  key={a.number}
                  value={`${a.number} ${a.customerName}`}
                  onSelect={() => go(`/accounts/${encodeURIComponent(a.number)}`)}
                >
                  <UserIcon />
                  <span className="truncate">{a.customerName}</span>
                  <CommandShortcut className="font-mono">{a.number}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
