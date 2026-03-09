/**
 * Trait-based action score biasing. Traits multiply action scores by tag so
 * personality tips close calls (e.g. brave → fight over flee, lazy → rest more).
 * Medium strength: multipliers ~0.85–1.25 so needs still dominate.
 */

import type { Goblin, GoblinTrait } from '../shared/types';
import type { Action, ActionTag } from './actions/types';

/** Per-trait, per-tag multiplier. Omit = 1.0. */
const TRAIT_TAG_MULT: Partial<Record<GoblinTrait, Partial<Record<ActionTag, number>>>> = {
  brave:     { combat: 1.25, safety: 0.85 },
  paranoid:  { safety: 1.20, combat: 0.80, explore: 0.90 },
  lazy:      { rest: 1.25, work: 0.90 },
  cheerful:  { social: 1.20, rest: 0.90 },
  mean:      { social: 0.85, combat: 1.10 },
  helpful:   { social: 1.20, work: 1.15 },
  greedy:    { share: 0.85, social: 0.90, withdraw: 1.15, eat: 1.10 },
  forgetful: { explore: 1.15, work: 0.90 },
};

export function getTraitTagMultiplier(trait: GoblinTrait, tag: ActionTag): number {
  return TRAIT_TAG_MULT[trait]?.[tag] ?? 1.0;
}

/**
 * Apply trait bias to an action's base score. Multiplies by the product of
 * per-tag multipliers for this goblin's trait, then clamps to [0, 1].
 */
export function applyTraitBias(goblin: Goblin, action: Action, baseScore: number): number {
  if (baseScore <= 0) return 0;
  let mult = 1.0;
  for (const tag of action.tags) {
    mult *= getTraitTagMultiplier(goblin.trait, tag);
  }
  return Math.min(1, Math.max(0, baseScore * mult));
}
