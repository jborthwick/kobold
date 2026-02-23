export enum TileType {
  Grass    = 'grass',
  Stone    = 'stone',
  Water    = 'water',
  Forest   = 'forest',
  Farmland = 'farmland',
  Ore      = 'ore',
}

export interface Tile {
  type: TileType;
  foodValue: number;      // 0–10
  materialValue: number;  // 0–10
  maxFood: number;        // growback cap
  maxMaterial: number;
}

export interface Inventory {
  food: number;
  materials: number;
}

export interface Dwarf {
  id: string;
  name: string;
  x: number;  // tile coords
  y: number;
  health: number;
  maxHealth: number;
  hunger: number;      // 0–100, 100 = starving
  metabolism: number;  // hunger added per tick
  vision: number;      // radius in tiles
  inventory: Inventory;
  morale: number;      // 0–100
  alive: boolean;
  task: string;
  commandTarget: { x: number; y: number } | null;  // player-issued move order
}

export interface LogEntry {
  tick: number;
  dwarfId: string;
  dwarfName: string;
  message: string;
  level: 'info' | 'warn' | 'error';
}

export interface GameState {
  tick: number;
  dwarves: Dwarf[];
  totalFood: number;
  totalMaterials: number;
  selectedDwarfId: string | null;
}
