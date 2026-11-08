import { cache } from "react";
import { getAuth } from "@/server/auth";
import { getApi, getSession } from "./session";

export interface Person {
  id: string;
  name: string;
}

/**
 * The organization's members, for turning user ids into names. Reading the member list can
 * be refused for some roles; then only the caller is named and everyone else is "A colleague".
 */
export const listPeople = cache(async (): Promise<Person[]> => {
  const [{ headers }, { organization, user }] = await Promise.all([getApi(), getSession()]);
  try {
    const { members } = await getAuth().api.listMembers({ headers, query: { organizationId: organization.id, limit: 500 } });
    return members.map((m) => ({ id: m.userId, name: m.user.name })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [{ id: user.id, name: user.name }];
  }
});

export const nameOf = (people: readonly Person[], id: string | null): string | null =>
  id === null ? null : (people.find((p) => p.id === id)?.name ?? "A colleague");
