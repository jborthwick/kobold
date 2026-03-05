/**
 * Roles, traits, and display: ROLE_*_APT, TRAIT_MODS, traitMod, getTraitDisplay, getRoleDisplay,
 * ROLE_ORDER, ROLE_STATS, GOBLIN_TRAITS, getGoblinBios, getGoblinGoals.
 */

import type { Goblin, GoblinRole, GoblinTrait } from '../../shared/types';
import { getActiveFaction } from '../../shared/factions';

// Role assignment order and vision ranges
export const ROLE_ORDER: GoblinRole[] = ['forager', 'miner', 'scout', 'lumberjack', 'fighter'];

export const ROLE_COMBAT_APT: Record<GoblinRole, number> = {
  fighter:    1.0,
  scout:      0.25,
  miner:      0.15,
  forager:    0.15,
  lumberjack: 0.15,
};
export const ROLE_MINING_APT: Record<GoblinRole, number> = {
  miner:      1.0,
  fighter:    0.15,
  scout:      0.15,
  forager:    0.10,
  lumberjack: 0.15,
};
export const ROLE_CHOP_APT: Record<GoblinRole, number> = {
  lumberjack: 1.0,
  scout:      0.15,
  miner:      0.10,
  forager:    0.10,
  fighter:    0.10,
};

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
  return getActiveFaction().traitDisplay;
}
export const GOBLIN_TRAIT_DISPLAY = new Proxy({} as Record<GoblinTrait, string>, {
  get: (_target, prop: string) => getActiveFaction().traitDisplay[prop as GoblinTrait],
});

export function getRoleDisplay(): Record<GoblinRole, string> {
  return getActiveFaction().roleDisplay;
}
export const GOBLIN_ROLE_DISPLAY = new Proxy({} as Record<GoblinRole, string>, {
  get: (_target, prop: string) => getActiveFaction().roleDisplay[prop as GoblinRole],
});

export const GOBLIN_TRAITS: GoblinTrait[] = [
  'lazy', 'forgetful', 'helpful', 'mean', 'paranoid', 'brave', 'greedy', 'cheerful',
];

export function getGoblinBios(): string[] {
  return getActiveFaction().bios;
}
export function getGoblinGoals(): string[] {
  return getActiveFaction().goals;
}

export const ROLE_STATS: Record<GoblinRole, { visionMin: number; visionMax: number; maxHealth: number }> = {
  forager:    { visionMin: 5, visionMax: 8,  maxHealth: 100 },
  miner:      { visionMin: 4, visionMax: 6,  maxHealth: 100 },
  scout:      { visionMin: 7, visionMax: 12, maxHealth: 100 },
  fighter:    { visionMin: 4, visionMax: 7,  maxHealth: 130 },
  lumberjack: { visionMin: 5, visionMax: 8,  maxHealth: 100 },
};
