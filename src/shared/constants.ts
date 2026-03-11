/**
 * Simulation and game constants. Change here rather than hardcoding elsewhere.
 */

/** World grid width and height in tiles (GRID_SIZE × GRID_SIZE). */
export const GRID_SIZE = 128;
/** Pixel size of one tile (Phaser and rendering). */
export const TILE_SIZE = 16;
/** Milliseconds between game ticks (~6–7/sec). Lower = faster sim. */
export const TICK_RATE_MS = 150;
/** Number of goblins spawned at game start. */
export const INITIAL_GOBLINS = 5;
/** Goblin inventory cap (food + ore + wood); harvesting stops when total reaches this. */
export const MAX_INVENTORY_CAPACITY = 20;

/** Name pool for goblins (spawn and succession). */
export const GOBLIN_NAMES = [
  'Grix', 'Snot', 'Murg', 'Blix', 'Rak',
  'Nub', 'Fizzle', 'Blort', 'Skritch', 'Gob',
  'Zog', 'Warts', 'Grub', 'Snag', 'Bleg',
  'Throk', 'Vix', 'Krimp', 'Durn', 'Fungus',
  'Pox', 'Moldy', 'Slimer', 'Gloom', 'Blight',
  'Nox', 'Spros', 'Krul', 'Zib', 'Gronk',
];
