import type { Tile, Goblin, Adventurer, ColonyGoal, FoodStockpile, OreStockpile, WoodStockpile, OverlayMode, LogEntry, Chapter } from './types';
import type { Weather } from '../simulation/weather';
import type { FactionId } from './factions';

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
  /** Selected faction — optional for backward compat (defaults to 'goblins'). */
  faction?: FactionId;
}

const KEY = 'kobold_save_v2';

export function saveGame(data: SaveData): void {
  localStorage.setItem(KEY, JSON.stringify(data));
}

export function loadGame(): SaveData | null {
  const s = localStorage.getItem(KEY);
  if (!s) return null;
  try {
    const data = JSON.parse(s) as SaveData;
    // Backward compat: add skill/wound fields if missing (pre-Iteration 10 saves)
    for (const d of data.goblins) {
      if (d.skillXp         === undefined) d.skillXp         = 0;
      if (d.skillLevel      === undefined) d.skillLevel      = 0;
      if (d.knownHearthSites === undefined) d.knownHearthSites = [];
      if (d.carryingWater   === undefined) d.carryingWater   = false;
      // wound is optional (undefined = healthy) — no migration needed
      // Iteration 17: split inventory.materials → inventory.ore + inventory.wood
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inv = d.inventory as any;
      if (inv.materials !== undefined) {
        d.inventory.ore  = d.role === 'miner'      ? (inv.materials ?? 0) : 0;
        d.inventory.wood = d.role === 'lumberjack' ? (inv.materials ?? 0) : 0;
        delete inv.materials;
      }
      if (d.inventory.ore  === undefined) d.inventory.ore  = 0;
      if (d.inventory.wood === undefined) d.inventory.wood = 0;
    }
    return data;
  } catch {
    return null;
  }
}

export function deleteSave(): void {
  localStorage.removeItem(KEY);
}

export function hasSave(): boolean {
  return !!localStorage.getItem(KEY);
}

/** Read save metadata without fully deserialising — used for the start menu display. */
export function peekSave(): { tick: number; aliveGoblins: number; faction?: FactionId } | null {
  const save = loadGame();
  if (!save) return null;
  return {
    tick:         save.tick,
    aliveGoblins: save.goblins.filter(d => d.alive).length,
    faction:      save.faction,
  };
}
