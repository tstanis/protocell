/**
 * @protocell/sim — the truth layer. SPEC.md §2.1, §3.
 *
 * No DOM, no network, no filesystem. tsconfig sets `"types": []` so Node globals are not
 * even in scope here: `process`, `fs`, and friends fail to typecheck rather than relying
 * on anyone remembering the rule. §3.7 puts renderers in a separate process; this is the
 * compile-time half of the same boundary.
 */

export * as constants from './constants.js';
export {
  Grid,
  Role,
  CYTOPLASM,
  EXTRACELLULAR,
  NO_COMPARTMENT,
  type RoleValue,
} from './grid.js';
export {
  SPECIES,
  SPECIES_ID,
  SPECIES_COUNT,
  D_BY_ID,
  OSMOTIC_BY_ID,
  speciesName,
  type SpeciesName,
  type SpeciesId,
  type AminoType,
} from './species.js';
export { diffuse, assertCFL, setCFLChecks } from './ops/diffuse.js';
export {
  applyTransport,
  bilayerP,
  carrier,
  channel,
  clampToEquilibrium,
  fluxOf,
  pump,
  type Transporter,
  type TransporterKind,
  type TransportResult,
} from './transport.js';
export {
  stampCell,
  orientMembrane,
  membraneTiles,
  gateTiles,
  isGateTile,
  faceTiles,
  type CellSpec,
} from './membrane.js';
export {
  Compartment,
  B_OSM,
  S_NOM,
  bleb,
  stepOsmosis,
  syncTileCounts,
  totalSolute,
  type OsmosisResult,
} from './compartment.js';
export {
  Enzyme,
  K_ON,
  payUpkeep,
  seedATP,
  stepMetabolism,
  totalATP,
  type MetabolismResult,
} from './metabolism.js';
export {
  FACE,
  World,
  type StepStats,
  type WorldOptions,
} from './world.js';
export { Nanobot, BOT_SPEED, BOT_REACH } from './nanobot.js';
export { GENES, atpCost, billOfMaterials, type Gene, type GeneId, type Product } from './genes.js';
export {
  BOND_TIME,
  FOLD_TIME,
  emptyBuild,
  nextResidue,
  startBuild,
  stepConstruction,
  type BuildPhase,
  type BuildState,
} from './construction.js';
export { Clock, type ClockOptions } from './clock.js';
export { Rng } from './rng.js';

export { Ribosome, RIBOSOME_REACH, RIBOSOME_BOND_TIME, inReach } from './ribosome.js';
export { MEAN_LIFETIME, STRESS_FACTOR, REPAIR_AT, efficiency, working, worn } from './denature.js';
export { SWITCH_MARGIN, chooseTarget, type Stock } from './scarcity.js';
export { grainUnit, isDiscrete, PARTICLE } from './grains.js';
