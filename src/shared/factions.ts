/**
 * Faction config — goblin colony display settings.
 *
 * FactionConfig holds all the display-layer content:
 * names, bios, goals, trait/role display labels, LLM prompt tone, and UI text.
 */

import type { GoblinRole, GoblinTrait } from './types';

export interface FactionConfig {
  /** Singular noun shown in UI. */
  unitNoun: string;
  /** Plural noun shown in UI. */
  unitNounPlural: string;
  /** Title shown on the start menu. */
  title: string;
  /** Subtitle shown under the title. */
  subtitle: string;
  /** Hint text on start menu. */
  startHint: string;
  /** Accent color (hex). */
  accentColor: string;

  // ── Content tables ──────────────────────────────────────────────────────────
  /** Pool of names assigned to goblins at spawn. */
  names: string[];
  /** Pool of quirky backstory one-liners. */
  bios: string[];
  /** Pool of personal goals. */
  goals: string[];
  /** Display labels for traits. */
  traitDisplay: Record<GoblinTrait, string>;
  /** Display labels for roles. */
  roleDisplay: Record<GoblinRole, string>;

  // ── LLM prompt flavor ───────────────────────────────────────────────────────
  /** Species noun used in LLM prompts. */
  llmSpecies: string;
  /** One-line role descriptions for LLM prompts. */
  llmRoleLabels: Record<GoblinRole, string>;
  /** Storyteller narrator tone instruction. */
  narratorTone: string;
  /** Succession LLM prompt template (placeholders: {name}, {deadName}, {deadRole}, {memSnippet}). */
  successionPrompt: string;

  // ── Event message flavor ────────────────────────────────────────────────────
  /** Verb for killing enemies (e.g. 'clobbered'). */
  killVerb: string;
  /** Raid announcement suffix. */
  raidSuffix: string;
  /** Enemy noun plural (e.g. 'adventurers'). */
  enemyNounPlural: string;

  // ── Colony goal descriptions ────────────────────────────────────────────────
  goalDescriptions: {
    stockpile_food: (target: number) => string;
    survive_ticks: (target: number) => string;
    defeat_adventurers: (target: number) => string;
    enclose_fort: () => string;
  };
}

// ── Goblin faction (the one and only) ────────────────────────────────────────

export const GOBLIN_FACTION: FactionConfig = {
  unitNoun: 'goblin',
  unitNounPlural: 'goblins',
  title: 'KOBOLD',
  subtitle: 'goblin colony sim',
  startHint: 'chaos awaits',
  accentColor: '#f0c040',

  names: [
    'Grix', 'Snot', 'Murg', 'Blix', 'Rak',
    'Nub', 'Fizzle', 'Blort', 'Skritch', 'Gob',
  ],
  bios: [
    'ate a rock once and liked it',
    'has an imaginary friend named Keith',
    'claims to have invented fire',
    'afraid of loud noises and also quiet ones',
    'once stole a sword bigger than himself',
    'was kicked out of three different caves',
    'firmly believes the moon is edible',
    'has a pet spider named Lord Bitington',
    'convinced he can talk to mushrooms',
    'lost a fight to a particularly aggressive squirrel',
  ],
  goals: [
    'eat something that isn\'t a bug',
    'find a rock that looks like a face',
    'go one whole day without being hit',
    'make a friend (a real one this time)',
    'find something shiny',
    'build something that doesn\'t fall down',
    'survive until lunch',
    'learn what a "plan" is',
  ],
  traitDisplay: {
    helpful: 'Surprisingly Generous',
    greedy: 'Shinies Hoarder',
    brave: 'Too Dumb to Run',
    paranoid: 'Sensibly Cautious',
    lazy: 'Professional Napper',
    cheerful: 'Annoyingly Cheerful',
    mean: 'Bitey',
    forgetful: 'What Was I Doing?',
  },
  roleDisplay: {
    forager: 'SCAVENGER',
    miner: 'ROCK BITER',
    scout: 'SNEAKY GIT',
    fighter: 'BASHER',
    lumberjack: 'TREE PUNCHER',
  },

  llmSpecies: 'goblin',
  llmRoleLabels: {
    forager: 'Scavenger — you find food that hasn\'t gone completely bad yet.',
    miner: 'Rock Biter — you chew through stone and sometimes find shiny things.',
    scout: 'Sneaky Git — you have wide vision and detect threats early (mostly by being paranoid).',
    fighter: 'Basher — you clobber adventurers who dare enter the colony.',
    lumberjack: 'Tree Puncher — you punch trees until they fall down (usually).',
  },
  narratorTone: 'darkly humorous, chaotic, told with affection for the hapless goblins',
  successionPrompt:
    'You are {name}, a new goblin stumbling into a chaotic colony. ' +
    '{deadName} ({deadRole}) recently died here.{memSnippet} ' +
    'In one sentence (max 15 words), what is your first thought? Be funny and goblin-like. ' +
    'Reply with just the sentence, no quotes.',

  killVerb: 'clobbered',
  raidSuffix: 'Run!',
  enemyNounPlural: 'adventurers',

  goalDescriptions: {
    stockpile_food: (t) => `Hoard ${t} food (without eating it all)`,
    survive_ticks: (t) => `Don't all die for ${t} ticks`,
    defeat_adventurers: (t) => `Clobber ${t} adventurers`,
    enclose_fort: () => 'Build walls (that hopefully stay up)',
  },
};

// ── Public API ───────────────────────────────────────────────────────────────

/** Returns the goblin faction config. */
export function getActiveFaction(): FactionConfig {
  return GOBLIN_FACTION;
}
