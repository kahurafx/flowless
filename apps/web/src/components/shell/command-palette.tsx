"use client";

import type { Entitlements, Permission } from "@flowless/shared-types";
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
import { searchAccountsAction } from "@/app/(staff)/accounts/actions";
import { navFor } from "./nav";

/** ⌘K / Ctrl+K: jump anywhere, find an account by number or name (NF-40). */
export function CommandPalette({
  entitlements,
  permissions,
}: {
  entitlements: Entitlements;
  permissions: readonly Permission[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; accounts: readonly { number: string; customerName: string }[] }>({ query: "", accounts: [] });
  const canSearch = entitlements.includes("accounts") && permissions.includes("accounts:read");
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

  // Accounts are found by the server as you type (number, name or phone), not preloaded.
  useEffect(() => {
    const q = query.trim();
    if (!canSearch || q.length < 2) return;
    let current = true;
    const timer = setTimeout(async () => {
      const result = await searchAccountsAction(q);
      if (current && result.error === null) setFound({ query: q, accounts: result.data });
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, canSearch]);
  const accounts = query.trim() === found.query ? found.accounts : [];

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
      <CommandDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }} title="Search" description="Jump to a page or account"
      >
        <CommandInput placeholder="Account number, customer, phone or page…" value={query} onValueChange={setQuery} />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          <CommandGroup heading="Go to">
            {navFor(entitlements, permissions).map((item) => (
              <CommandItem key={item.href} onSelect={() => go(item.href)}>
                <item.icon />
                {item.label}
              </CommandItem>
            ))}
          </CommandGroup>
          {canSearch && accounts.length > 0 && (
            <CommandGroup heading="Accounts">
              {accounts.map((a) => (
                <CommandItem
                  key={a.number}
                  value={`${a.number} ${a.customerName} ${query}`}
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
