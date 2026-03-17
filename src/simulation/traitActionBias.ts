/**
 * Trait-based action score biasing. Traits multiply action scores by tag so
 * personality strongly influences job choice (e.g. crafty → cook/saw/forge,
 * lazy → avoid physical work). Work-tag multipliers ~0.70–1.35; survival
 * (eat, safety, rest) stay milder so needs still win in crises.
 *
 * TRAIT_STRENGTH: 0 = no effect, 1 = full table; >1 amplifies both prefer and avoid.
 * TRAIT_SCORE_CAP: allows preferred actions to exceed 1.0 so they can win after other bonuses (pipeline uses same cap).
 */

import type { Goblin, GoblinTrait } from '../shared/types';
import type { Action, ActionTag } from './actions/types';

/** 0 = no trait effect; 1 = full table; >1 amplifies both prefer and avoid so trait strength above 1.0 affects the game. */
export const TRAIT_STRENGTH = 1.0;

/** Max score after trait bias; should not exceed the pipeline cap in utilityAI. Lets preferred actions exceed 1.0. */
export const TRAIT_SCORE_CAP = 2.0;

/** Per-trait, per-tag multiplier. Omit = 1.0. Work tags use wider spread (0.70–1.35) for role diversity. */
const TRAIT_TAG_MULT: Partial<Record<GoblinTrait, Partial<Record<ActionTag, number>>>> = {
  brave:     { combat: 1.25, safety: 0.85, mine: 1.10, chop: 1.08, forge: 1.06 },
  paranoid:  { safety: 1.20, combat: 0.80, explore: 0.90, cook: 1.08, saw: 1.08, forge: 1.05, mine: 0.92, chop: 0.92 },
  lazy:      { rest: 1.25, work: 0.90, chop: 0.75, forge: 0.75, mine: 0.75, forage: 0.80 },
  cheerful:  { social: 1.20, rest: 0.90, cook: 1.15, forage: 1.12, chop: 1.05, mine: 1.05, saw: 1.10, forge: 1.08 },
  mean:      { social: 0.85, combat: 1.10, cook: 0.75 },
  helpful:   { social: 1.20, work: 1.15, cook: 1.20, forage: 1.25, chop: 1.20 },
  greedy:    { share: 0.85, social: 0.90, withdraw: 1.15, eat: 1.10, forage: 1.25 },
  forgetful: { explore: 1.15, work: 0.90, cook: 0.75, saw: 0.75 },
  curious:   { explore: 1.20, work: 0.92, forage: 1.25 },
  stubborn:  { rest: 0.88, work: 1.12, forge: 1.25, mine: 1.20 },
  cowardly:  { safety: 1.22, combat: 0.82, cook: 1.10, forage: 1.08, saw: 1.08, forge: 0.90, mine: 0.90, chop: 0.92 },
  glutton:   { eat: 1.15, share: 0.88, cook: 1.18, forage: 1.08 },
  crafty:    { cook: 1.35, saw: 1.35, forge: 1.35 },
};

function getTraitTagMultiplierRaw(trait: GoblinTrait, tag: ActionTag): number {
  return TRAIT_TAG_MULT[trait]?.[tag] ?? 1.0;
}

/** Effective multiplier: TRAIT_STRENGTH scales both prefer (raw > 1) and avoid (raw < 1). */
export function getTraitTagMultiplier(trait: GoblinTrait, tag: ActionTag): number {
  const raw = getTraitTagMultiplierRaw(trait, tag);
  return 1 + (raw - 1) * TRAIT_STRENGTH;
}

/**
 * Apply trait bias to an action's base score. Multiplies by the product of
 * per-tag multipliers, then clamps to [0, TRAIT_SCORE_CAP] so preferred actions can exceed 1.0.
 */
export function applyTraitBias(goblin: Goblin, action: Action, baseScore: number): number {
  if (baseScore <= 0) return 0;
  let mult = 1.0;
  for (const tag of action.tags) {
    mult *= getTraitTagMultiplier(goblin.trait, tag);
  }
  return Math.min(TRAIT_SCORE_CAP, Math.max(0, baseScore * mult));
}
