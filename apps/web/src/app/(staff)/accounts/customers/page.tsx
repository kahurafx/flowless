import { CUSTOMER_TYPES, type CustomerType } from "@flowless/shared-types";
import { PhoneOffIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { ListFilters, NextPage } from "@/components/list-filters";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listCustomers } from "@/data/customers";
import { customerTypeLabel } from "@/lib/account-labels";

export const metadata = { title: "Customers" };

// C-01: people and organizations, found by name, phone, email or id number.
export default function CustomersPage({ searchParams }: PageProps<"/accounts/customers">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Customers searchParams={searchParams} />
    </Suspense>
  );
}

async function Customers({ searchParams }: { searchParams: PageProps<"/accounts/customers">["searchParams"] }) {
  const params = await searchParams;
  const text = (v: string | string[] | undefined) => (typeof v === "string" && v !== "" ? v : undefined);
  const type = CUSTOMER_TYPES.find((t) => t === text(params.type)) as CustomerType | undefined;
  const data = await listCustomers({ q: text(params.q), type, after: text(params.after) });
  return (
    <>
      <PageHeader
        title="Customers"
        description="Who holds accounts. Open a customer to edit their details and contacts."
        actions={
          data.canCreate && (
            <Button render={<Link href="/accounts/new" />}>
              <PlusIcon />
              New account
            </Button>
          )
        }
      />
      <ListFilters search={{ placeholder: "Search name, phone, email or id number" }} filters={[{ param: "type", label: "All types", options: CUSTOMER_TYPES.map((t) => ({ value: t, label: customerTypeLabel[t] })) }]} />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Customer</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Id number</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  {data.searched ? "No customer matches that search." : "No customers yet."}
                </TableCell>
              </TableRow>
            ) : (
              data.rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="max-w-72">
                    <Link href={`/accounts/customers/${c.id}`} className="truncate font-medium text-primary hover:underline" title={c.name}>
                      {c.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{customerTypeLabel[c.type]}</Badge>
                  </TableCell>
                  <TableCell>
                    {c.phone ? (
                      <span className="tabular">{c.phone}</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-warning">
                        <PhoneOffIcon className="size-3" /> No phone
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{c.email ?? <span className="text-muted-foreground">None</span>}</TableCell>
                  <TableCell className="font-mono text-xs">{c.nationalId ?? c.registrationNumber ?? <span className="font-sans text-muted-foreground">None</span>}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <NextPage cursor={data.nextCursor} />
    </>
  );
}
