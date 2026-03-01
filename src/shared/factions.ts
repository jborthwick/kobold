/**
 * Faction system — cosmetic framework for goblin (chaos) vs dwarf (order) colonies.
 *
 * FactionConfig holds all the display-layer content that differs between factions:
 * names, bios, goals, trait/role display labels, LLM prompt tone, and UI text.
 * Game mechanics (BT thresholds, combat, resource rules) are identical for both.
 */

import type { GoblinRole, GoblinTrait } from './types';

export type FactionId = 'goblins' | 'dwarves';

export interface FactionConfig {
  /** Internal identifier. */
  id:             FactionId;
  /** Singular noun shown in UI ('goblin' | 'dwarf'). */
  unitNoun:       string;
  /** Plural noun shown in UI ('goblins' | 'dwarves'). */
  unitNounPlural: string;
  /** Title shown on the start menu. */
  title:          string;
  /** Subtitle shown under the title. */
  subtitle:       string;
  /** Hint text on start menu. */
  startHint:      string;
  /** Accent color for the faction (hex). */
  accentColor:    string;

  // ── Content tables ──────────────────────────────────────────────────────────
  /** Pool of names assigned to units at spawn. */
  names:          string[];
  /** Pool of quirky backstory one-liners. */
  bios:           string[];
  /** Pool of personal goals. */
  goals:          string[];
  /** Display labels for traits (internal trait keys unchanged). */
  traitDisplay:   Record<GoblinTrait, string>;
  /** Display labels for roles (internal role keys unchanged). */
  roleDisplay:    Record<GoblinRole, string>;

  // ── LLM prompt flavor ───────────────────────────────────────────────────────
  /** Species noun used in LLM prompts ('goblin' | 'dwarf'). */
  llmSpecies:     string;
  /** One-line role descriptions for LLM prompts (keyed by GoblinRole). */
  llmRoleLabels:  Record<GoblinRole, string>;
  /** Storyteller narrator tone instruction. */
  narratorTone:   string;
  /** Succession LLM prompt template (placeholders: {name}, {deadName}, {deadRole}, {memSnippet}). */
  successionPrompt: string;

  // ── Event message flavor ────────────────────────────────────────────────────
  /** Verb for killing enemies (e.g. 'clobbered', 'slew'). */
  killVerb:       string;
  /** Raid announcement suffix (e.g. 'Run!', 'To arms!'). */
  raidSuffix:     string;
  /** Enemy faction noun plural (e.g. 'adventurers', 'goblins'). */
  enemyNounPlural: string;

  // ── Colony goal descriptions ────────────────────────────────────────────────
  goalDescriptions: {
    stockpile_food:     (target: number) => string;
    survive_ticks:      (target: number) => string;
    defeat_adventurers: (target: number) => string;
    enclose_fort:       () => string;
  };
}

// ── Goblin faction (default — chaos) ─────────────────────────────────────────

export const GOBLIN_FACTION: FactionConfig = {
  id:             'goblins',
  unitNoun:       'goblin',
  unitNounPlural: 'goblins',
  title:          'KOBOLD',
  subtitle:       'goblin colony sim',
  startHint:      'chaos awaits',
  accentColor:    '#f0c040',

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
    helpful:   'Surprisingly Generous',
    greedy:    'Shinies Hoarder',
    brave:     'Too Dumb to Run',
    paranoid:  'Sensibly Cautious',
    lazy:      'Professional Napper',
    cheerful:  'Annoyingly Cheerful',
    mean:      'Bitey',
    forgetful: 'What Was I Doing?',
  },
  roleDisplay: {
    forager:    'SCAVENGER',
    miner:      'ROCK BITER',
    scout:      'SNEAKY GIT',
    fighter:    'BASHER',
    lumberjack: 'TREE PUNCHER',
  },

  llmSpecies: 'goblin',
  llmRoleLabels: {
    forager:    'Scavenger — you find food that hasn\'t gone completely bad yet.',
    miner:      'Rock Biter — you chew through stone and sometimes find shiny things.',
    scout:      'Sneaky Git — you have wide vision and detect threats early (mostly by being paranoid).',
    fighter:    'Basher — you clobber adventurers who dare enter the colony.',
    lumberjack: 'Tree Puncher — you punch trees until they fall down (usually).',
  },
  narratorTone: 'darkly humorous, chaotic, told with affection for the hapless goblins',
  successionPrompt:
    'You are {name}, a new goblin stumbling into a chaotic colony. ' +
    '{deadName} ({deadRole}) recently died here.{memSnippet} ' +
    'In one sentence (max 15 words), what is your first thought? Be funny and goblin-like. ' +
    'Reply with just the sentence, no quotes.',

  killVerb:        'clobbered',
  raidSuffix:      'Run!',
  enemyNounPlural: 'adventurers',

  goalDescriptions: {
    stockpile_food:     (t) => `Hoard ${t} food (without eating it all)`,
    survive_ticks:      (t) => `Don't all die for ${t} ticks`,
    defeat_adventurers: (t) => `Clobber ${t} adventurers`,
    enclose_fort:       ()  => 'Build walls (that hopefully stay up)',
  },
};

// ── Dwarf faction (order) ────────────────────────────────────────────────────

export const DWARF_FACTION: FactionConfig = {
  id:             'dwarves',
  unitNoun:       'dwarf',
  unitNounPlural: 'dwarves',
  title:          'IRONHOLD',
  subtitle:       'dwarf colony sim',
  startHint:      'for the mountain',
  accentColor:    '#c0a060',

  names: [
    'Brom', 'Durin', 'Thrain', 'Gimli', 'Balin',
    'Nori', 'Fili', 'Dwalin', 'Ori', 'Gloin',
  ],
  bios: [
    'has never once left a job unfinished',
    'polishes his axe every morning without fail',
    'hums the same mining song for hours on end',
    'swore an oath to the mountain as a child',
    'catalogues every stone he has ever broken',
    'can smell iron ore from twenty paces',
    'quotes the old laws before every meal',
    'carved his first rune at age four',
    'refuses to eat anything that isn\'t properly cooked',
    'once reinforced a crumbling wall during an earthquake',
  ],
  goals: [
    'reinforce the eastern wall',
    'stockpile enough food for a harsh winter',
    'keep the forge burning through the night',
    'earn the respect of the elder council',
    'mine a vein of pure mithril',
    'build something that will outlast him',
    'train the next generation properly',
    'map every tunnel beneath the hold',
  ],
  traitDisplay: {
    helpful:   'Steadfast Ally',
    greedy:    'Gold-Hungry',
    brave:     'Fearless',
    paranoid:  'Ever-Vigilant',
    lazy:      'Work-Shy',
    cheerful:  'Merry',
    mean:      'Gruff',
    forgetful: 'Absent-Minded',
  },
  roleDisplay: {
    forager:    'FORAGER',
    miner:      'MINER',
    scout:      'SCOUT',
    fighter:    'WARRIOR',
    lumberjack: 'WOODCUTTER',
  },

  llmSpecies: 'dwarf',
  llmRoleLabels: {
    forager:    'Forager — you gather food and provisions for the hold.',
    miner:      'Miner — you excavate stone and ore from the deep veins.',
    scout:      'Scout — you watch the perimeter and report threats early.',
    fighter:    'Warrior — you defend the hold against all who threaten it.',
    lumberjack: 'Woodcutter — you fell timber for construction and fuel.',
  },
  narratorTone: 'solemn and saga-like, told in the tradition of dwarven chronicles — stoic, proud, with dry understatement',
  successionPrompt:
    'You are {name}, a young dwarf arriving at an embattled hold. ' +
    '{deadName} ({deadRole}) recently fell in service.{memSnippet} ' +
    'In one sentence (max 15 words), what is your first thought? Be stoic and dwarven. ' +
    'Reply with just the sentence, no quotes.',

  killVerb:        'slew',
  raidSuffix:      'To arms!',
  enemyNounPlural: 'goblins',

  goalDescriptions: {
    stockpile_food:     (t) => `Stockpile ${t} provisions in the hold`,
    survive_ticks:      (t) => `Endure for ${t} ticks without falling`,
    defeat_adventurers: (t) => `Defeat ${t} goblin raiders`,
    enclose_fort:       ()  => 'Complete the outer fortifications',
  },
};

// ── Active faction ───────────────────────────────────────────────────────────

/** The faction selected at game start. Defaults to goblins. */
let _activeFaction: FactionConfig = GOBLIN_FACTION;

export function getActiveFaction(): FactionConfig {
  return _activeFaction;
}

export function setActiveFaction(id: FactionId): void {
  _activeFaction = id === 'dwarves' ? DWARF_FACTION : GOBLIN_FACTION;
}

/** Lookup table for faction configs by id. */
export const FACTIONS: Record<FactionId, FactionConfig> = {
  goblins: GOBLIN_FACTION,
  dwarves: DWARF_FACTION,
};
