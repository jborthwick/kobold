import type { Tile, Dwarf, Goblin, ColonyGoal, FoodStockpile, OreStockpile, WoodStockpile, OverlayMode, LogEntry } from './types';
import type { Weather } from '../simulation/weather';

export interface SaveData {
  version: 1;
  tick: number;
  grid: Tile[][];
  dwarves: Dwarf[];
  goblins: Goblin[];
  colonyGoal: ColonyGoal;
  foodStockpiles: FoodStockpile[];
  oreStockpiles: OreStockpile[];
  woodStockpiles: WoodStockpile[];
  goblinKillCount: number;
  spawnZone: { x: number; y: number; w: number; h: number };
  pendingSuccessions: { deadDwarfId: string; spawnAtTick: number }[];
  commandTile: { x: number; y: number } | null;
  speed: number;
  overlayMode: OverlayMode;
  logHistory: LogEntry[];
  nextWorldEventTick: number;
  /** Weather state — optional for backward compat with old saves. */
  weather?: Weather;
}

const KEY = 'kobold_save_v1';

export function saveGame(data: SaveData): void {
  localStorage.setItem(KEY, JSON.stringify(data));
}

export function loadGame(): SaveData | null {
  const s = localStorage.getItem(KEY);
  if (!s) return null;
  try {
    return JSON.parse(s) as SaveData;
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
export function peekSave(): { tick: number; aliveDwarves: number } | null {
  const save = loadGame();
  if (!save) return null;
  return {
    tick:         save.tick,
    aliveDwarves: save.dwarves.filter(d => d.alive).length,
  };
}
