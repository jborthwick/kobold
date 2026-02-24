export enum TileType {
  Dirt     = 'dirt',
  Grass    = 'grass',
  Stone    = 'stone',
  Water    = 'water',
  Forest   = 'forest',
  Farmland = 'farmland',
  Ore      = 'ore',
}

export interface Tile {
  type: TileType;
  foodValue: number;      // current food on tile
  materialValue: number;  // current material on tile
  maxFood: number;        // growback ceiling
  maxMaterial: number;
  growbackRate: number;   // food units restored per tick (0 = doesn't regrow)
}

export interface Inventory {
  food: number;
  materials: number;
}

// PIANO step 5 — structured intent the LLM can set to override the BT
export type LLMIntent = 'eat' | 'forage' | 'rest' | 'avoid' | 'none';

// PIANO step 7 — one entry per LLM decision; last 5 injected into next prompt
export interface MemoryEntry {
  tick:     number;
  crisis:   string;   // CrisisSituation.type
  action:   string;   // decision.action text
  outcome?: string;   // backfilled by VERIFY step (~40 ticks later)
}

// Agent role — assigned at spawn, permanent
export type DwarfRole = 'forager' | 'miner' | 'scout';

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
  llmReasoning:    string | null;    // last LLM decision shown in DwarfPanel
  llmIntent:       LLMIntent | null; // active override intent (expires at llmIntentExpiry)
  llmIntentExpiry: number;           // tick after which intent is discarded
  memory:          MemoryEntry[];    // last 5 decisions, oldest-first
  role:            DwarfRole;
}

export interface LogEntry {
  tick: number;
  dwarfId: string;
  dwarfName: string;
  message: string;
  level: 'info' | 'warn' | 'error';
}

export type OverlayMode = 'off' | 'food' | 'material';

export interface GameState {
  tick: number;
  dwarves: Dwarf[];
  totalFood: number;
  totalMaterials: number;
  selectedDwarfId: string | null;
  overlayMode: OverlayMode;
}
