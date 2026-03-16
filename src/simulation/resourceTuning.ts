/**
 * Centralized tuning constants for resource balance and stockpile behaviour.
 * All tier pressures (consumables, ore, wood, upgrades) use a single source of truth
 * per tier so midpoints and action heuristics stay in sync.
 *
 * Consumables = food + meals (one tier). Ore and wood use per-goblin scaling when
 * livingGoblinCount is known; upgrades use a single absolute midpoint.
 */

// ── Baseline (when colony size unknown) ─────────────────────────────────────────

/** Fallback goblin count for pressure math when livingGoblinCount is 0 or unknown. */
export const DEFAULT_GOBLINS_FOR_PRESSURE = 5;

// ── Consumables (food + meals combined) ────────────────────────────────────────

/**
 * Desired combined food+meals buffer per living goblin. Drives consumablesPressure:
 * pressure is high when (food+meals)/goblin is below this.
 */
export const CONSUMABLES_BUFFER_PER_GOBLIN = 19;

/**
 * consumablesPressure above this → "stock the larder" floors apply in forage/deposit.
 */
export const FOOD_STOCK_LARDER_PRESSURE = 0.5;

// ── Ore (per-goblin scaling) ───────────────────────────────────────────────────

/**
 * Desired ore buffer per living goblin. Drives orePressure: pressure is high when
 * totalOre/goblin is below this. Mining action uses orePressure for scarcity floors.
 */
export const ORE_BUFFER_PER_GOBLIN = 16;

// ── Wood (per-goblin scaling) ──────────────────────────────────────────────────

/**
 * Desired wood buffer per living goblin. Drives woodPressure: pressure is high when
 * totalWood/goblin is below this. Chop action uses woodPressure for scarcity floors.
 */
export const WOOD_BUFFER_PER_GOBLIN = 8;

/**
 * Wood buffer per refuelable hearth. When totalWood < this × refuelableHearthCount,
 * chop gets a small boost so hearths get fuel.
 */
export const HEARTH_WOOD_LOW_PER_HEARTH = 20;

// ── Upgrades (bars + planks; absolute target) ─────────────────────────────────

/**
 * Bars + planks stock where upgradesPressure is ~0.5. Absolute target (not per-goblin).
 */
export const UPGRADES_MIDPOINT = 50;

// ── Cooking (local mix: meals fraction) ───────────────────────────────────────

/**
 * Cook when meals are below this fraction of total consumables (food+meals).
 */
export const MEALS_FRACTION_COOK_BELOW = 0.5;

/**
 * consumablesPressure must be at least this to consider cooking (colony not starving).
 */
export const COOK_MIN_CONSUMABLES_PRESSURE = 0.25;
