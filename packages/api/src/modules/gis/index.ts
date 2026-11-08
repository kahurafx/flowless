import type { WorkRegistry } from "../../kernel/work";
import { GIS_WORK_KINDS } from "./kinds";
import { LEGACY_FIELD_PREFIX, personalBranchGuard } from "./link/branch-guard";
import { gisWorkOrderEffects } from "./link/effects";
import { gisAssetResolver, gisEvidenceResolver } from "./link/resolvers";

/*
 * The GIS module's published interface (NF-30): what `wiring.ts`, `root.ts` and the kernel
 * registries use. Other modules reach GIS assets and logs only through the kernel work
 * ports registered here, and its facts through the events below.
 */

/**
 * Plugs GIS into the kernel's work ports: its kinds, the asset and evidence resolvers, the
 * job effects, the personal-branch guard ("fld-") and the reserved, unguarded "field-"
 * prefix (Majimap's open personal branches, refused in Flowless).
 */
export function register(work: WorkRegistry) {
  for (const kind of GIS_WORK_KINDS) work.registerWorkKind(kind);
  work.registerAssetResolver(gisAssetResolver);
  work.registerEvidenceResolver(gisEvidenceResolver);
  work.registerEffects(gisWorkOrderEffects);
  work.registerBranchGuard(personalBranchGuard);
  work.reserveBranchPrefix(LEGACY_FIELD_PREFIX);
}

export { createGisRouter } from "./router";
export { gisAssetFileSubject, GIS_ASSET_FILES } from "./files";
export { conditionTrendReport, recentFindingsReport } from "./reports";
export { GIS_WORK_KINDS } from "./kinds";
export {
  gisBranchCancelled,
  gisBranchReady,
  gisBranchSubmitted,
  gisConditionChanged,
  gisConnectionPosted,
  seedAttachmentRulesOnLicence,
} from "./events";
