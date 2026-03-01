/**
 * Injury / Wound system — single wound slot per goblin.
 *
 * Wounds are rolled on adventurer hit (60% chance total).
 * Each wound type has a specific gameplay effect and heal duration.
 * Effects feed into existing shared state (fatigue, vision, yield, damage)
 * so the Utility AI adapts automatically.
 *
 * Wound types:
 *   bruised (30%) — 80 ticks  — fatigue +0.3/tick extra
 *   leg     (15%) — 150 ticks — 40% chance to skip movement each tick
 *   arm     (10%) — 120 ticks — harvest/mine yield ×0.5, combat damage ×0.6
 *   eye      (5%) — 200 ticks — vision −3 tiles (min 1)
 */

import type { Goblin, Wound, WoundType } from '../shared/types';
import { skillVisionBonus } from './skills';

type LogFn = (message: string, level: 'info' | 'warn' | 'error') => void;

// ── Wound roll table ────────────────────────────────────────────────────────

interface WoundDef {
  type:     WoundType;
  chance:   number;   // cumulative threshold (checked in order)
  duration: number;   // ticks until healed
  label:    string;   // display name for logs
}

const WOUND_TABLE: WoundDef[] = [
  { type: 'bruised', chance: 0.30, duration:  80, label: 'bruised'    },
  { type: 'leg',     chance: 0.45, duration: 150, label: 'leg wound'  },
  { type: 'arm',     chance: 0.55, duration: 120, label: 'arm wound'  },
  { type: 'eye',     chance: 0.60, duration: 200, label: 'eye wound'  },
];

/**
 * Roll for a wound on adventurer hit. Returns a Wound or undefined.
 * Only rolls if the goblin has no existing wound.
 */
export function rollWound(goblin: Goblin, tick: number): Wound | undefined {
  if (goblin.wound) return undefined;  // already wounded

  const roll = Math.random();
  for (const def of WOUND_TABLE) {
    if (roll < def.chance) {
      return { type: def.type, healTick: tick + def.duration };
    }
  }
  return undefined;  // 40% — no wound
}

/** Human-readable label for a wound type. */
export function woundLabel(type: WoundType): string {
  return WOUND_TABLE.find(d => d.type === type)?.label ?? type;
}

// ── Wound effect helpers ────────────────────────────────────────────────────

/**
 * Effective vision radius combining base vision, eye wound penalty, and scout skill bonus.
 * Use this everywhere instead of raw `goblin.vision`.
 */
export function effectiveVision(goblin: Goblin): number {
  let v = goblin.vision + skillVisionBonus(goblin);
  if (goblin.wound?.type === 'eye') v -= 3;
  return Math.max(1, v);
}

/** Movement skip for leg wound: 40% chance to skip this tick's movement. */
export function isLegWoundSkip(goblin: Goblin): boolean {
  return goblin.wound?.type === 'leg' && Math.random() < 0.4;
}

/** Harvest / mine yield multiplier: 0.5× with arm wound, 1× otherwise. */
export function woundYieldMultiplier(goblin: Goblin): number {
  return goblin.wound?.type === 'arm' ? 0.5 : 1.0;
}

/** Combat damage multiplier: 0.6× with arm wound, 1× otherwise. */
export function woundDamageMultiplier(goblin: Goblin): number {
  return goblin.wound?.type === 'arm' ? 0.6 : 1.0;
}

// ── Healing ─────────────────────────────────────────────────────────────────

/** Check and heal expired wounds. Called in updateNeeds() every tick. */
export function tickWoundHealing(goblin: Goblin, tick: number, onLog?: LogFn): void {
  if (!goblin.wound) return;
  if (tick >= goblin.wound.healTick) {
    const label = woundLabel(goblin.wound.type);
    goblin.wound = undefined;
    onLog?.(`💚 ${label} has healed`, 'info');
  }
}

/** Accelerate wound healing (used by rest action). Reduces healTick by amount. */
export function accelerateHealing(goblin: Goblin, ticks: number): void {
  if (goblin.wound) {
    goblin.wound.healTick -= ticks;
  }
}
