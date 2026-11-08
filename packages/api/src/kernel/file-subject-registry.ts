import { gisAssetFileSubject } from "../modules/gis";
import { workOrderFileSubject } from "../modules/work-orders";
import type { FileSubjectDef } from "./file-subjects";

/**
 * Every file subject (K-08). A module adds its own when it ships (work orders, assets,
 * accounts), defined in its module folder with `defineFileSubject`. Kept apart from
 * `file-subjects.ts` so modules can import the definitions without a cycle.
 */
export const fileSubjects: readonly FileSubjectDef[] = [workOrderFileSubject, gisAssetFileSubject];

const kinds = new Set<string>();
for (const s of fileSubjects) {
  if (kinds.has(s.kind)) throw new Error(`File subject "${s.kind}" is registered twice`);
  kinds.add(s.kind);
}
