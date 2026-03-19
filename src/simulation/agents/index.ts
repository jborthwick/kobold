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
  pruneInvalidKnownFoodSites,
} from './sites';

export {
  type TraitMods,
  TRAIT_MODS,
  traitMod,
  getTraitDisplay,
  GOBLIN_TRAIT_DISPLAY,
  GOBLIN_TRAITS,
  getGoblinBios,
  getGoblinGoals,
} from './roles';

export {
  pathNextStep,
  bestFoodTile,
  bestMaterialTile,
  bestWoodTile,
} from './pathfinding';

export {
  fortWallSlots,
  fortEnclosureSlots,
  roomWallSlots,
  fortifiableRoomWallSlots,
  fortifiableRooms,
  isWallSlotTerrain,
} from './fort';

export { spawnGoblins, spawnSuccessor, SUCCESSION_DELAY } from './spawn';

