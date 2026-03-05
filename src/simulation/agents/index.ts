/**
 * Agents public API. Modules: sites, roles, pathfinding, fort, spawn.
 * Import from './agents' (or '../simulation/agents') to get all exports.
 */

export {
  SITE_RECORD_THRESHOLD,
  MAX_KNOWN_SITES,
  PATCH_MERGE_RADIUS,
  recordSite,
  FORAGEABLE_TILES,
} from './sites';

export {
  ROLE_ORDER,
  ROLE_COMBAT_APT,
  ROLE_MINING_APT,
  ROLE_CHOP_APT,
  type TraitMods,
  TRAIT_MODS,
  traitMod,
  getTraitDisplay,
  getRoleDisplay,
  GOBLIN_TRAIT_DISPLAY,
  GOBLIN_ROLE_DISPLAY,
  GOBLIN_TRAITS,
  getGoblinBios,
  getGoblinGoals,
  ROLE_STATS,
} from './roles';

export {
  pathNextStep,
  bestFoodTile,
  bestMaterialTile,
  bestWoodTile,
} from './pathfinding';

export { fortWallSlots, fortEnclosureSlots } from './fort';

export { spawnGoblins, spawnSuccessor, SUCCESSION_DELAY } from './spawn';

