/**
 * Persist full game state to localStorage (key: kobold_save_v2). SaveData mirrors live state;
 * optional fields allow backward compat. WorldTick auto-saves; StartMenu/WorldInit load via loadGame().
 *
 * Adding new persisted fields: add to SaveData (optional if compat needed). In loadGame(), add
 * migration — top-level: data.newField ??= default; per-goblin: loop data.goblins and set
 * if (d.newField === undefined) d.newField = default. Ensure buildSaveData() and load path include it.
 * See existing migrations (thoughts, memories, skills, rooms, mealStockpiles, etc.) as template.
 */

import type { Tile, Goblin, Adventurer, ColonyGoal, FoodStockpile, MealStockpile, OreStockpile, WoodStockpile, PlankStockpile, BarStockpile, OverlayMode, LogEntry, Chapter, Room } from './types';
import type { Weather } from '../simulation/weather';
import type { WorkerTargets } from '../simulation/workerTargets';
import { HEARTH_FUEL_MAX } from './constants';
import { TileType } from './types';

export interface SaveData {
  version: 2;
  tick: number;
  grid: Tile[][];
  goblins: Goblin[];
  adventurers: Adventurer[];
  colonyGoal: ColonyGoal;
  foodStockpiles: FoodStockpile[];
  oreStockpiles: OreStockpile[];
  woodStockpiles: WoodStockpile[];
  adventurerKillCount: number;
  spawnZone: { x: number; y: number; w: number; h: number };
  pendingSuccessions: { deadGoblinId: string; spawnAtTick: number }[];
  commandTile: { x: number; y: number } | null;
  speed: number;
  overlayMode: OverlayMode;
  logHistory: LogEntry[];
  nextWorldEventTick: number;
  /** Weather state — optional for backward compat with old saves. */
  weather?: Weather;
  /** World seed — optional for backward compat with old saves. */
  worldSeed?: string;
  /** Chronicle chapters — optional for backward compat with old saves. */
  chapters?: Chapter[];
  /** Tick at which the current goal started — optional for backward compat. */
  goalStartTick?: number;
  /** Player-placed rooms — optional for backward compat. */
  rooms?: Room[];
  /** Meal stockpiles inside kitchens — optional for backward compat. */
  mealStockpiles?: MealStockpile[];
  /** Plank stockpiles in lumber huts. */
  plankStockpiles?: PlankStockpile[];
  /** Bar stockpiles in blacksmiths. */
  barStockpiles?: BarStockpile[];
  /** Cumulative meals cooked this colony — optional for backward compat. */
  mealsCooked?: number;
  /** Target worker headcounts per work category — optional for backward compat. */
  workerTargets?: WorkerTargets;
}

const KEY = 'kobold_save_v2';

/** Write full game state to localStorage. On quota exceeded, tries to delete the old save and retry. */
export function saveGame(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (e) {
    // If quota exceeded, clear old save and retry once
    if ((e as Error).name === 'QuotaExceededError') {
      console.warn('localStorage quota exceeded; clearing old save and retrying...');
      localStorage.removeItem(KEY);
      try {
        localStorage.setItem(KEY, JSON.stringify(data));
      } catch (retryErr) {
        console.error('Failed to save game even after clearing old save:', retryErr);
        throw retryErr;
      }
    } else {
      throw e;
    }
  }
}

/** Parse and migrate from localStorage; returns null if missing/invalid. Mutates parsed data in place for migrations. */
export function loadGame(): SaveData | null {
  const s = localStorage.getItem(KEY);
  if (!s) return null;
  try {
    const data = JSON.parse(s) as SaveData;
    // Backward compat: add skill/wound fields if missing (pre-Iteration 10 saves)
    for (const d of data.goblins) {
      if (d.thoughts === undefined) d.thoughts = [];
      if (d.memories === undefined) d.memories = [];
      if (d.knownHearthSites === undefined) d.knownHearthSites = [];
      if (d.carryingWater === undefined) d.carryingWater = false;
      if (d.onFire === undefined) d.onFire = false;
      if (d.moveTarget === undefined) d.moveTarget = null;
      if (d.moveExpiry === undefined) d.moveExpiry = 0;
      if (d.cookingLastActiveTick === undefined) d.cookingLastActiveTick = 0;
      if (d.lastActionName === undefined) d.lastActionName = '';
      // lastWorkCategory / lastWorkCategoryTick optional — no migration needed (undefined = not set)
      // wound is optional (undefined = healthy) — no migration needed
      // Iteration 17: split inventory.materials → inventory.ore + inventory.wood
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inv = d.inventory as any;
      const role = (d as any).role as string | undefined;
      if (inv.materials !== undefined) {
        d.inventory.ore = role === 'miner' ? (inv.materials ?? 0) : 0;
        d.inventory.wood = role === 'lumberjack' ? (inv.materials ?? 0) : 0;
        delete inv.materials;
      }
      if (d.inventory.ore === undefined) d.inventory.ore = 0;
      if (d.inventory.wood === undefined) d.inventory.wood = 0;
      if (d.inventory.meals === undefined) d.inventory.meals = 0;

      // Migration: convert old role + skillXp to new skills SkillSet
      if ((d as any).role !== undefined) {
        const oldSkillXp = (d as any).skillXp ?? 0;
        const roleSkillMap: Record<string, keyof typeof d.skills> = {
          forager: 'forage', miner: 'mine', lumberjack: 'chop',
          fighter: 'combat', scout: 'scout'
        };
        d.skills = { forage: 0, mine: 0, chop: 0, combat: 0, scout: 0, cook: 0, saw: 0, smith: 0 };
        const skillKey = roleSkillMap[role ?? ''];
        if (skillKey) d.skills[skillKey] = oldSkillXp;
        delete (d as any).role;
        delete (d as any).skillXp;
        delete (d as any).skillLevel;
      } else if (!d.skills) {
        // Fresh save with new format
        d.skills = { forage: 0, mine: 0, chop: 0, combat: 0, scout: 0, cook: 0, saw: 0, smith: 0 };
      } else {
        // Migration: add cook/saw/smith to existing SkillSet (old saves had only 5 keys)
        const s = d.skills as Record<string, number>;
        if (s.cook === undefined) s.cook = 0;
        if (s.saw === undefined) s.saw = 0;
        if (s.smith === undefined) s.smith = 0;
      }
      // assignedJob: optional; undefined from old saves = no job (no migration required, but normalize to null if desired)
      if (d.assignedJob === undefined) d.assignedJob = null;
    }
    data.rooms ??= [];
    data.mealStockpiles ??= [];
    data.workerTargets ??= {};
    data.plankStockpiles ??= [];
    data.barStockpiles ??= [];
    data.mealsCooked ??= 0;
    // Migrate: remove legacy meals field from food stockpiles
    for (const sp of data.foodStockpiles) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (sp as any).meals;
    }
    // Migrate: hearth tiles get initial fuel so "lit" = hearthFuel > 0
    for (let gy = 0; gy < data.grid.length; gy++) {
      const row = data.grid[gy];
      if (!row) continue;
      for (let gx = 0; gx < row.length; gx++) {
        const t = row[gx];
        if (t?.type === TileType.Hearth && t.hearthFuel === undefined) {
          t.hearthFuel = HEARTH_FUEL_MAX;
        }
      }
    }
    return data;
  } catch {
    return null;
  }
}

/** Remove the save (e.g. new colony). */
export function deleteSave(): void {
  localStorage.removeItem(KEY);
}

/** True if a save exists (start menu Continue button). */
export function hasSave(): boolean {
  return !!localStorage.getItem(KEY);
}

/** Read save metadata without fully deserialising — used for the start menu display. */
export function peekSave(): { tick: number; aliveGoblins: number } | null {
  const save = loadGame();
  if (!save) return null;
  return {
    tick: save.tick,
    aliveGoblins: save.goblins.filter(d => d.alive).length,
  };
}
