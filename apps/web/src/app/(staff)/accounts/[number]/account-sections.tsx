import { ArrowRightIcon, MapPinIcon, PhoneOffIcon } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AccountPage } from "@/data/accounts";
import { displayPhone } from "@/lib/account-forms";
import { commandKindLabel, contactChannelLabel, contactKindLabel, customerTypeLabel, servicePointStatusLabel } from "@/lib/account-labels";
import { formatWhen } from "@/lib/dates";
import { commercialStatusLabel, serviceStateLabel } from "@/lib/account-labels";
import { accountHref } from "../accounts-table";

export function Section({ id, title, aside, children }: { id: string; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="grid gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium break-words">{children}</dd>
    </div>
  );
}

/** Category, parent, membership and the succession links (C-02, C-07, C-08). */
export function Overview({ page }: { page: AccountPage }) {
  const { account } = page;
  return (
    <dl className="grid grid-cols-2 gap-4 rounded-xl border bg-card p-4 text-sm sm:grid-cols-4">
      {page.showCategory && <Detail label="Category">{page.categoryName ?? <span className="text-muted-foreground">None</span>}</Detail>}
      <Detail label="Phone">{account.phone ? displayPhone(account.phone) : <Badge variant="warning">No phone</Badge>}</Detail>
      <Detail label="Opened">{formatWhen(account.openedAt, page.locale, page.timeZone, "date")}</Detail>
      {account.parent && (
        <Detail label="Parent account">
          <Link href={accountHref(account.parent.number)} className="text-primary hover:underline">
            {account.parent.number}
          </Link>
          {page.parentName && <span className="block text-xs font-normal text-muted-foreground">{page.parentName}</span>}
        </Detail>
      )}
      {account.parent && <Detail label="Membership class">{page.membership ?? <span className="text-muted-foreground">No class</span>}</Detail>}
      {account.children.length > 0 && (
        <Detail label="Child accounts">
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {account.children.map((c) => (
              <Link key={c.id} href={accountHref(c.number)} className="font-mono text-xs text-primary hover:underline">
                {c.number}
              </Link>
            ))}
          </span>
        </Detail>
      )}
      {page.predecessorNumber && (
        <Detail label="Succeeds">
          <Link href={accountHref(page.predecessorNumber)} className="font-mono text-xs text-primary hover:underline">
            {page.predecessorNumber}
          </Link>
        </Detail>
      )}
      {page.successorNumber && (
        <Detail label="Succeeded by">
          <Link href={accountHref(page.successorNumber)} className="font-mono text-xs text-primary hover:underline">
            {page.successorNumber}
          </Link>
        </Detail>
      )}
    </dl>
  );
}

/** The customer and their contacts. A placeholder number is shown as "No phone" (C-01). */
export function CustomerSection({ page }: { page: AccountPage }) {
  const { customer } = page;
  if (!customer) {
    return (
      <Section id="customer" title="Customer">
        <p className="text-sm text-muted-foreground">{page.account.customerName}. The customer&apos;s details are not visible to you.</p>
      </Section>
    );
  }
  return (
    <Section
      id="customer"
      title="Customer"
      aside={
        <Link href={`/accounts/customers/${customer.id}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          Open customer <ArrowRightIcon className="size-3.5" />
        </Link>
      }
    >
      <p className="text-sm">
        <span className="font-medium">{customer.name}</span> <span className="text-muted-foreground">· {customerTypeLabel[customer.type]}</span>
        {(customer.nationalId ?? customer.registrationNumber) && <span className="text-muted-foreground"> · {customer.nationalId ?? customer.registrationNumber}</span>}
      </p>
      {customer.contacts.length === 0 ? (
        <p className="inline-flex items-center gap-1.5 text-sm text-warning">
          <PhoneOffIcon className="size-4" /> No contacts on file
        </p>
      ) : (
        <ul className="grid gap-1.5 text-sm">
          {customer.contacts.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2">
              <span className="w-14 text-xs text-muted-foreground">{contactChannelLabel[c.channel]}</span>
              {c.isPlaceholder ? (
                <>
                  <Badge variant="warning">No phone</Badge>
                  <span className="text-xs text-muted-foreground">placeholder {c.value} is kept but not used</span>
                </>
              ) : (
                <span className="tabular">{c.value}</span>
              )}
              <span className="text-xs text-muted-foreground">{contactKindLabel[c.kind]}</span>
              {c.isPrimary && <Badge variant="outline">Primary</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Service points with their place labels and GPS (glossary: service point). */
export function ServicePointsSection({ page }: { page: AccountPage }) {
  const { servicePoints } = page.account;
  return (
    <Section id="service-points" title="Service points">
      {servicePoints.length === 0 ? (
        <p className="text-sm text-muted-foreground">No service point yet. Add one before the account can be connected.</p>
      ) : (
        <ul className="grid gap-3">
          {servicePoints.map((s) => {
            const { areas: places, route: routeName } = page.pointPlaces[s.id] ?? { areas: [], route: null };
            return (
              <li key={s.id} className="grid gap-1 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <MapPinIcon className="size-4 text-muted-foreground" aria-hidden />
                    {s.address}
                  </span>
                  <Badge variant={s.connectionStatus === "CONNECTED" ? "success" : s.connectionStatus === "DECOMMISSIONED" ? "outline" : "secondary"}>{servicePointStatusLabel[s.connectionStatus]}</Badge>
                </div>
                <p className="text-muted-foreground">
                  {places.length > 0 ? places.join(" › ") : "No area set"}
                  {routeName ? ` · ${routeName}` : " · No route"}
                </p>
                <p className="tabular text-xs text-muted-foreground">{s.location ? `GPS ${s.location.lat.toFixed(5)}, ${s.location.lng.toFixed(5)}` : "No GPS position"}</p>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** Who has held the account and when (C-10). */
export function HoldersSection({ page }: { page: AccountPage }) {
  return (
    <Section id="holders" title="Holder history" aside={<span className="text-xs text-muted-foreground">Insert-only: a change of name adds a row</span>}>
      <ol className="grid gap-1.5 text-sm">
        {page.holders.map((h) => (
          <li key={`${h.customerId}-${h.validFrom}`} className="flex flex-wrap items-baseline gap-x-3">
            <Link href={`/accounts/customers/${h.customerId}`} className="font-medium hover:underline">
              {h.name}
            </Link>
            <span className="tabular text-muted-foreground">
              from {h.validFrom}
              {h.validTo ? ` to ${h.validTo}` : " (current)"}
            </span>
            {h.previousClosingReadingRef && <span className="text-xs text-muted-foreground">closing reading {h.previousClosingReadingRef}</span>}
          </li>
        ))}
      </ol>
    </Section>
  );
}

/** The command history: every status change with its reason, who and when (C-03). */
export function CommandsSection({ page }: { page: AccountPage }) {
  return (
    <Section id="history" title="Status history">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>When</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>By</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.commands.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="h-16 text-center text-muted-foreground">
                  Nothing has changed yet.
                </TableCell>
              </TableRow>
            ) : (
              page.commands.map((c) => {
                const moved = c.fromCommercialStatus !== c.toCommercialStatus;
                const service = c.fromServiceStatus !== c.toServiceStatus;
                return (
                  <TableRow key={c.id}>
                    <TableCell className="tabular whitespace-nowrap">{formatWhen(c.occurredAt, page.locale, page.timeZone)}</TableCell>
                    <TableCell className="min-w-44">
                      <span className="font-medium">{commandKindLabel[c.kind]}</span>
                      {(moved || service) && (
                        <span className="block text-xs text-muted-foreground">
                          {moved && `${commercialStatusLabel[c.fromCommercialStatus]} to ${commercialStatusLabel[c.toCommercialStatus]}`}
                          {moved && service && " · "}
                          {service && `Service ${serviceStateLabel[c.fromServiceStatus].toLowerCase()} to ${serviceStateLabel[c.toServiceStatus].toLowerCase()}`}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="min-w-56 whitespace-normal">
                      {c.reason}
                      {c.note && <span className="block text-xs text-muted-foreground">{c.note}</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{c.actor}</TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </Section>
  );
}

/**
 * The statement and ledger are Phase 4 (Billing). There is nothing real to show, and the Phase 1
 * demo ledger belonged to demo accounts that no longer exist, so this says so instead of inventing numbers.
 */
export function StatementPlaceholder() {
  return (
    <Section id="statement" title="Statement" aside={<Badge variant="outline">Phase 4</Badge>}>
      <p className="text-sm text-muted-foreground">
        The ledger, balance and statement arrive with Billing. Until then an account holds no balance, which is why terminating one asks you to confirm that nothing is owing.
      </p>
    </Section>
  );
}
