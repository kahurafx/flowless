import { DropletsIcon } from "lucide-react";

/** The user's one organization (no switching: requirements §1). Collapses to the icon. */
export function OrganizationBadge({ organization }: { organization: { name: string; code: string } }) {
  return (
    <div className="flex items-center gap-2 p-1" title={`${organization.name} (${organization.code.toUpperCase()})`}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <DropletsIcon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
        <span className="truncate text-sm font-medium">{organization.name}</span>
        <span className="label-caps text-muted-foreground">{organization.code.toUpperCase()}</span>
      </span>
    </div>
  );
}
