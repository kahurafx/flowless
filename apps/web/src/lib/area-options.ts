import { areaLevelLabel, type AreaLevel } from "@flowless/shared-types";

/*
 * Choices for the place pickers (K-02). An organization uses the levels it needs, so each
 * picker (scheme, zone, DMA) offers the areas of its levels that sit under whatever is
 * already chosen above it. The API checks the chain again.
 */

export interface AreaChoice {
  id: string;
  name: string;
  level: AreaLevel;
  parentId: string | null;
}

/** The ids above `id`, nearest first. */
function ancestorsOf(areas: readonly AreaChoice[], id: string): Set<string> {
  const byId = new Map(areas.map((a) => [a.id, a]));
  const found = new Set<string>();
  for (let at = byId.get(id)?.parentId; at && !found.has(at); at = byId.get(at)?.parentId) found.add(at);
  return found;
}

/** Areas of `levels` that sit under every id in `under` (ids left blank are ignored), labelled with their level. */
export function areaChoices(areas: readonly AreaChoice[], levels: readonly AreaLevel[], under: readonly string[]): { value: string; label: string }[] {
  const chosen = under.filter((id) => id !== "");
  return areas
    .filter((a) => levels.includes(a.level))
    .filter((a) => {
      if (chosen.length === 0) return true;
      const above = ancestorsOf(areas, a.id);
      return chosen.every((id) => above.has(id));
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => ({ value: a.id, label: a.level === "sub_zone" ? `${a.name} (${areaLevelLabel[a.level].toLowerCase()})` : a.name }));
}

/** Does `id` appear in `choices`? Used to drop a selection that a change above it made impossible. */
export const stillOffered = (choices: readonly { value: string }[], id: string) => id === "" || choices.some((c) => c.value === id);
