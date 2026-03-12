/**
 * Traits and display: TRAIT_MODS, traitMod, getTraitDisplay,
 * GOBLIN_TRAITS, getGoblinBios, getGoblinGoals.
 * Roles removed — all goblins have the same base stats; skills earned organically.
 */

import type { Goblin, GoblinTrait } from '../../shared/types';
import { getGoblinConfig } from '../../shared/goblinConfig';

export interface TraitMods {
  shareThreshold?: number;
  shareDonorKeeps?: number;
  eatThreshold?: number;
  fleeThreshold?: number;
  wanderHomeDrift?: number;
  contestPenalty?: number;
  shareRelationGate?: number;
  fatigueRate?: number;
  socialDecayBonus?: number;
  hungerCrisisThreshold?: number;
  moraleCrisisThreshold?: number;
  exhaustionThreshold?: number;
  lonelinessCrisisThreshold?: number;
  perceptiveness?: number;
  gatheringPower?: number;
  chopPower?: number;
  generosityRange?: number;
  huntRange?: number;
  wariness?: number;
  coziness?: number;
  maxSearchRadius?: number;
  healthBonus?: number;
}

export const TRAIT_MODS: Record<GoblinTrait, TraitMods> = {
  helpful:   { shareThreshold: 6, shareDonorKeeps: 3, shareRelationGate: 15, lonelinessCrisisThreshold: 55, generosityRange: 3 },
  greedy:    { shareThreshold: 12, shareDonorKeeps: 8, generosityRange: 1 },
  brave:     { fleeThreshold: 95, moraleCrisisThreshold: 30, healthBonus: 20, huntRange: 2.5 },
  paranoid:  { fleeThreshold: 60, wanderHomeDrift: 0.5, moraleCrisisThreshold: 50, hungerCrisisThreshold: 55, perceptiveness: 2, wariness: 4, healthBonus: -10 },
  lazy:      { eatThreshold: 55, fatigueRate: 1.3, exhaustionThreshold: 65, hungerCrisisThreshold: 58 },
  cheerful:  { shareThreshold: 6, shareRelationGate: 20, socialDecayBonus: 0.15, generosityRange: 3 },
  mean:      { shareThreshold: 14, contestPenalty: -10, shareRelationGate: 55, lonelinessCrisisThreshold: 85, generosityRange: 1 },
  forgetful: {},
};

export function traitMod<K extends keyof TraitMods>(goblin: Goblin, key: K, fallback: number): number {
  return TRAIT_MODS[goblin.trait]?.[key] ?? fallback;
}

export function getTraitDisplay(): Record<GoblinTrait, string> {
  return getGoblinConfig().traitDisplay;
}
export const GOBLIN_TRAIT_DISPLAY = new Proxy({} as Record<GoblinTrait, string>, {
  get: (_target, prop: string) => getGoblinConfig().traitDisplay[prop as GoblinTrait],
});


export const GOBLIN_TRAITS: GoblinTrait[] = [
  'lazy', 'forgetful', 'helpful', 'mean', 'paranoid', 'brave', 'greedy', 'cheerful',
];

export function getGoblinBios(): string[] {
  return getGoblinConfig().bios;
}
export function getGoblinGoals(): string[] {
  return getGoblinConfig().goals;
}

