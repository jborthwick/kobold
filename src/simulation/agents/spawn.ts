/**
 * Spawn and succession: spawnGoblins, spawnSuccessor, SUCCESSION_DELAY.
 */

import type { Goblin, Tile, MemoryEntry } from '../../shared/types';
import { INITIAL_GOBLINS } from '../../shared/constants';
import { getActiveFaction } from '../../shared/factions';
import { isWalkable } from '../world';
import { xpToLevel } from '../skills';
import {
  ROLE_ORDER,
  ROLE_STATS,
  TRAIT_MODS,
  GOBLIN_TRAITS,
  getGoblinBios,
  getGoblinGoals,
} from './roles';

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function toRoman(n: number): string {
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
  let result = '';
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) { result += syms[i]; n -= vals[i]; }
  }
  return result;
}

export function spawnGoblins(
  grid:      Tile[][],
  spawnZone: { x: number; y: number; w: number; h: number },
): Goblin[] {
  const goblins: Goblin[] = [];
  for (let i = 0; i < INITIAL_GOBLINS; i++) {
    let x: number, y: number;
    do {
      x = spawnZone.x + rand(0, spawnZone.w - 1);
      y = spawnZone.y + rand(0, spawnZone.h - 1);
    } while (!isWalkable(grid, x, y));

    const role = ROLE_ORDER[i % ROLE_ORDER.length];
    const stats = ROLE_STATS[role];
    const trait = GOBLIN_TRAITS[Math.floor(Math.random() * GOBLIN_TRAITS.length)];
    const healthBonus = TRAIT_MODS[trait]?.healthBonus ?? 0;
    const maxHealth = Math.max(10, stats.maxHealth + healthBonus);

    const factionNames = getActiveFaction().names;
    const baseName = factionNames[i % factionNames.length];
    goblins.push({
      id:            `goblin-${i}`,
      name:          baseName,
      baseName,
      generation:    1,
      x, y,
      health:        maxHealth,
      maxHealth,
      hunger:        rand(10, 30),
      metabolism:    Math.round((0.15 + Math.random() * 0.2) * 100) / 100,
      vision:        rand(stats.visionMin, stats.visionMax),
      inventory:     { food: rand(8, 15), ore: 0, wood: 0 },
      morale:        70 + rand(0, 20),
      alive:         true,
      task:          'idle',
      role,
      commandTarget: null,
      llmReasoning:   null,
      llmIntent:     null,
      llmIntentExpiry: 0,
      memory:        [],
      relations:     {},
      trait,
      bio:           getGoblinBios()[Math.floor(Math.random() * getGoblinBios().length)],
      goal:          getGoblinGoals()[Math.floor(Math.random() * getGoblinGoals().length)],
      wanderTarget:  null,
      wanderExpiry:  0,
      knownFoodSites:   [],
      knownOreSites:    [],
      knownWoodSites:   [],
      knownHearthSites: [],
      homeTile:        { x: 0, y: 0 },
      adventurerKills:  0,
      fatigue:         0,
      social:          0,
      lastSocialTick:  0,
      lastLoggedTicks:  { morale_high: 0 },
      skillXp:         0,
      skillLevel:      0,
    });
  }
  return goblins;
}

/** Ticks before a successor arrives after a death (~43 s at 7 ticks/s). */
export const SUCCESSION_DELAY = 300;

export function spawnSuccessor(
  dead:       Goblin,
  grid:       Tile[][],
  spawnZone:  { x: number; y: number; w: number; h: number },
  allDwarves: Goblin[],
  tick:       number,
): Goblin {
  const baseName = dead.baseName;
  const generation = dead.generation + 1;
  const name = generation === 1 ? baseName : `${baseName} ${toRoman(generation)}`;

  const role = ROLE_ORDER[Math.floor(Math.random() * ROLE_ORDER.length)];
  const stats = ROLE_STATS[role];
  const trait = GOBLIN_TRAITS[Math.floor(Math.random() * GOBLIN_TRAITS.length)];
  const healthBonus = TRAIT_MODS[trait]?.healthBonus ?? 0;
  const maxHealth = Math.max(10, stats.maxHealth + healthBonus);

  let x: number, y: number;
  do {
    x = spawnZone.x + rand(0, spawnZone.w - 1);
    y = spawnZone.y + rand(0, spawnZone.h - 1);
  } while (!isWalkable(grid, x, y));

  const inheritedMemory: MemoryEntry[] = dead.memory.slice(-2).map(m => ({
    tick,
    crisis:  'inheritance',
    action:  `${dead.name} once: "${m.action}"`,
    outcome: m.outcome,
  }));
  if (dead.causeOfDeath) {
    inheritedMemory.unshift({
      tick,
      crisis: 'inheritance',
      action: `${dead.name} died of ${dead.causeOfDeath}`,
    });
  }

  const sortedRels = Object.entries(dead.relations).sort(([, a], [, b]) => b - a);
  const topAlly = sortedRels.find(([, s]) => s > 60);
  const topRival = [...sortedRels].reverse().find(([, s]) => s < 40);
  if (topAlly) {
    const allyDwarf = allDwarves.find(d => d.id === topAlly[0]);
    if (allyDwarf) inheritedMemory.push({ tick, crisis: 'inheritance',
      action: `${dead.name}'s closest companion was ${allyDwarf.name}` });
  }
  if (topRival) {
    const rivalDwarf = allDwarves.find(d => d.id === topRival[0]);
    if (rivalDwarf) inheritedMemory.push({ tick, crisis: 'inheritance',
      action: `${dead.name}'s greatest rival was ${rivalDwarf.name}` });
  }

  const relations: Record<string, number> = {};
  for (const [id2, score] of Object.entries(dead.relations)) {
    relations[id2] = Math.round(50 + (score - 50) * 0.5);
  }

  return {
    id:            `goblin-${Date.now()}`,
    name,
    baseName,
    generation,
    x, y,
    health:        maxHealth,
    maxHealth,
    hunger:        rand(10, 30),
    metabolism:    Math.round((0.15 + Math.random() * 0.2) * 100) / 100,
    vision:        rand(stats.visionMin, stats.visionMax),
    inventory:     { food: rand(5, 12), ore: 0, wood: 0 },
    morale:        60 + rand(0, 20),
    alive:         true,
    task:          'just arrived',
    role,
    commandTarget:   null,
    llmReasoning:    null,
    llmIntent:       null,
    llmIntentExpiry: 0,
    memory:          inheritedMemory,
    relations,
    trait,
    bio:             getGoblinBios()[Math.floor(Math.random() * getGoblinBios().length)],
    goal:            getGoblinGoals()[Math.floor(Math.random() * getGoblinGoals().length)],
    wanderTarget:    null,
    wanderExpiry:    0,
    knownFoodSites:   [],
    knownOreSites:    [],
    knownWoodSites:   [],
    knownHearthSites: [],
    homeTile:        { x: 0, y: 0 },
    adventurerKills:  0,
    fatigue:         0,
    social:          0,
    lastSocialTick:  0,
    lastLoggedTicks:  { morale_high: 0 },
    skillXp:         Math.floor(dead.skillXp * 0.25),
    skillLevel:      xpToLevel(Math.floor(dead.skillXp * 0.25)),
  };
}
