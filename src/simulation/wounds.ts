/**
 * Injury / Wound system — single wound slot per dwarf.
 *
 * Wounds are rolled on goblin hit (60% chance total).
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

import type { Dwarf, Wound, WoundType } from '../shared/types';
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
 * Roll for a wound on goblin hit. Returns a Wound or undefined.
 * Only rolls if the dwarf has no existing wound.
 */
export function rollWound(dwarf: Dwarf, tick: number): Wound | undefined {
  if (dwarf.wound) return undefined;  // already wounded

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
 * Use this everywhere instead of raw `dwarf.vision`.
 */
export function effectiveVision(dwarf: Dwarf): number {
  let v = dwarf.vision + skillVisionBonus(dwarf);
  if (dwarf.wound?.type === 'eye') v -= 3;
  return Math.max(1, v);
}

/** Movement skip for leg wound: 40% chance to skip this tick's movement. */
export function isLegWoundSkip(dwarf: Dwarf): boolean {
  return dwarf.wound?.type === 'leg' && Math.random() < 0.4;
}

/** Harvest / mine yield multiplier: 0.5× with arm wound, 1× otherwise. */
export function woundYieldMultiplier(dwarf: Dwarf): number {
  return dwarf.wound?.type === 'arm' ? 0.5 : 1.0;
}

/** Combat damage multiplier: 0.6× with arm wound, 1× otherwise. */
export function woundDamageMultiplier(dwarf: Dwarf): number {
  return dwarf.wound?.type === 'arm' ? 0.6 : 1.0;
}

// ── Healing ─────────────────────────────────────────────────────────────────

/** Check and heal expired wounds. Called in updateNeeds() every tick. */
export function tickWoundHealing(dwarf: Dwarf, tick: number, onLog?: LogFn): void {
  if (!dwarf.wound) return;
  if (tick >= dwarf.wound.healTick) {
    const label = woundLabel(dwarf.wound.type);
    dwarf.wound = undefined;
    onLog?.(`💚 ${label} has healed`, 'info');
  }
}

/** Accelerate wound healing (used by rest action). Reduces healTick by amount. */
export function accelerateHealing(dwarf: Dwarf, ticks: number): void {
  if (dwarf.wound) {
    dwarf.wound.healTick -= ticks;
  }
}
