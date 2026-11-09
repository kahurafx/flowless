import type { FileSubjectDef } from "./file-subjects";

/**
 * Every file subject (K-08). A module adds its own (work orders, assets, accounts) from its
 * `registerKernel` (called in `src/wiring.ts`) with `registerFileSubject`, defined in its
 * module folder with `defineFileSubject`. Kept apart from `file-subjects.ts` so modules can
 * import the definitions without a cycle. Live: read it only after wiring.
 */
export const fileSubjects: readonly FileSubjectDef[] = [];

const list = fileSubjects as FileSubjectDef[];

export function registerFileSubject(def: FileSubjectDef): void {
  if (list.some((s) => s.kind === def.kind)) throw new Error(`File subject "${def.kind}" is registered twice`);
  list.push(def);
}
