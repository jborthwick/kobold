/**
 * Centralized tuning constants for resource balance and stockpile behaviour.
 * Consumables = food + meals (one tier). consumablesPressure encodes colony-level
 * food safety; meals vs raw food mix is handled locally (e.g. cooking ratio).
 */

// ── Consumables (food + meals combined) ──────────────────────────────────────

/**
 * Desired combined food+meals buffer per living goblin. Drives consumablesPressure
 * when using per-goblin scaling: pressure is high when (food+meals)/goblin is below this.
 */
export const CONSUMABLES_BUFFER_PER_GOBLIN = 19;

/**
 * consumablesPressure above this → "stock the larder" floors apply in forage/deposit.
 * One global consumables tier; no separate food vs meals targets.
 */
export const FOOD_STOCK_LARDER_PRESSURE = 0.5;

// ── Global response-curve midpoints (other tiers; stockpile size where pressure ~0.5) ─────

/** Ore stock where orePressure is ~0.5. */
export const ORE_MIDPOINT = 40;

/** Wood stock where woodPressure is ~0.5. */
export const WOOD_MIDPOINT = 25;

/** Bars + planks stock where upgradesPressure is ~0.5. */
export const UPGRADES_MIDPOINT = 50;

// ── Ore tuning ────────────────────────────────────────────────────────────────

/**
 * Ore buffer per living goblin once a blacksmith exists. The effective
 * scarcity threshold is ORE_SCARCE_PER_GOBLIN × livingGoblinCount.
 */
export const ORE_SCARCE_PER_GOBLIN = 16;

// ── Wood tuning ───────────────────────────────────────────────────────────────

/**
 * Wood buffer per living goblin once a lumber hut exists. The effective
 * scarcity threshold is WOOD_SCARCE_PER_GOBLIN × livingGoblinCount.
 */
export const WOOD_SCARCE_PER_GOBLIN = 8;

/**
 * Wood buffer per refuelable hearth. The effective "low wood for hearths"
 * threshold is HEARTH_WOOD_LOW_PER_HEARTH × refuelableHearthCount.
 */
export const HEARTH_WOOD_LOW_PER_HEARTH = 20;

// ── Cooking (local mix: meals fraction) ───────────────────────────────────────

/**
 * Cook when meals are below this fraction of total consumables (food+meals).
 * Prevents converting all food into meals; mix is handled locally in cook action.
 */
export const MEALS_FRACTION_COOK_BELOW = 0.5;

/**
 * consumablesPressure must be at least this to consider cooking (colony not starving).
 */
export const COOK_MIN_CONSUMABLES_PRESSURE = 0.25;

