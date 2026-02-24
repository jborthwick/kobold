export const GRID_SIZE = 64;
export const TILE_SIZE = 16;
export const TICK_RATE_MS = 150; // ~6-7 ticks/second
export const INITIAL_DWARVES = 5;
export const GROWBACK_RATE = 0.003; // slow recovery — depleted patches stay bare for ~50s
export const MAX_FOOD_VALUE = 10;
export const MAX_MATERIAL_VALUE = 10;
export const MAX_INVENTORY_FOOD = 10; // cap — dwarves stop harvesting when full

export const DWARF_NAMES = [
  'Urist', 'Bomrek', 'Iden', 'Sibrek', 'Reg',
  'Meng', 'Nish', 'Kulet', 'Doren', 'Kol',
];
