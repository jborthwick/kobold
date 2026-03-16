/**
 * Centralized tuning constants for resource balance and stockpile behaviour.
 * Adjust these midpoints / thresholds to change when goblins feel "safe" on
 * food, ore, wood, and upgrades, and how aggressively they stock the larder.
 */

// ── Global response-curve midpoints (stockpile size where pressure ~0.5) ─────

/** Food + meals stock where consumables pressure is ~0.5. */
export const CONSUMABLES_MIDPOINT = 95;

/** Ore stock where orePressure is ~0.5. */
export const ORE_MIDPOINT = 40;

/** Wood stock where woodPressure is ~0.5. */
export const WOOD_MIDPOINT = 25;

/** Bars + planks stock where upgradesPressure is ~0.5. */
export const UPGRADES_MIDPOINT = 50;

// ── Food / larder tuning ─────────────────────────────────────────────────────

/** Total stored food below this: storage is considered "hungry" for larder logic. */
export const FOOD_LARDER_TARGET = 100;

/**
 * consumablesPressure above this → "stock the larder" floors apply in forage/deposit.
 * Kept aligned with CONSUMABLES_MIDPOINT.
 */
export const FOOD_STOCK_LARDER_PRESSURE = 0.5;

// ── Ore tuning ────────────────────────────────────────────────────────────────

/**
 * With a blacksmith built, ore below this is treated as "ore scarce" — miners
 * get extra urgency and score floors so smithing is fed.
 */
export const ORE_SCARCE_WITH_BLACKSMITH = 80;

// ── Wood tuning ───────────────────────────────────────────────────────────────

/**
 * With a lumber hut built, wood below this is treated as "wood scarce" — chop
 * gets extra urgency and score floors so construction and fuel are supplied.
 */
export const WOOD_SCARCE_WITH_LUMBER_HUT = 40;

/**
 * When total wood is below this and hearths need fuel, chop gets an extra bump
 * to keep fires from going out.
 */
export const HEARTH_WOOD_LOW = 20;

// ── Cooking / meals tuning ───────────────────────────────────────────────────

/** Soft cap for meals stored in the kitchen; cooks idle once this is reached. */
export const MAX_MEALS_STORED = 80;

