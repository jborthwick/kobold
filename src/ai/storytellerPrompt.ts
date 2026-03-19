/**
 * Pure storyteller prompt construction + chapter event selection (testable, headless-safe).
 */

import type { Adventurer, Chapter, ColonyGoal, Goblin, LogEntry } from '../shared/types';
import { getGoblinConfig } from '../shared/goblinConfig';

/**
 * Franchise voice (comedy of errors, empathy). Included in {@link STORYTELLER_SYSTEM_PROMPT} for game + headless.
 */
export const STORYTELLER_GAME_BRIEF =
  'You are the storyteller for Kobold, a story-generating colony sim about goblins muddling through survival. ' +
  'Their lives are a comedy of errors: small minds, big problems, and schemes that rarely survive contact with reality. ' +
  'Have empathy for their plight, but always surface the intrinsic humor—absurdity, hubris, and lucky breaks. ' +
  'This is not grimdark: even when stakes are high, keep the voice wry, warm, or ridiculous rather than nihilistic.';

/** Prose constraints (appended after game brief in every storyteller system message). */
const STORYTELLER_PROSE_RULES =
  'How to write: sharp tabletop recap, not purple fantasy prose.\n\n' +
  'Prose rules:\n' +
  '- Never cite game stats: no hitpoints, HP, numbers in combat, skill names as stats, "Lv.", or levels.\n' +
  '- Describe outcomes in plain language (e.g. "a savage beating", "got sharper at finding food").\n' +
  '- Colonists are goblins (roster + named event speakers). Lines tagged with the human raider label are adventurers/outsiders—not goblins.\n' +
  '- Name at most 2–3 colonist goblins total. Pick one thread (injury, raid hangover, goal done, feud)—do not give each sentence a new goblin or location like a tour.\n' +
  '- Only imply cause→effect if the event list clearly supports it; never invent links.\n' +
  '- Stick to what events suggest. Do not add scenic filler (breeze, blue sky, birds, "proudly surveyed", scribbling on rocks) unless the event list clearly implies it.\n' +
  '- Open with one concrete beat from the events, then stay with that thread or one tight pivot—no camera-pan across the whole colony.\n' +
  '- 2–4 short sentences; past tense, third person, no dialogue. One sentence may be a punchy fragment.\n' +
  '- If the user message includes "Chronicle so far", use those excerpts only for voice continuity; write this chapter about the current milestone and key events—do not retell prior chapters.\n' +
  'Length: about 50–85 words total.';

/**
 * Full system message: same string for in-game chronicle, headless `--story` LLM, and any proxy that supports `system`.
 */
export const STORYTELLER_SYSTEM_PROMPT = `${STORYTELLER_GAME_BRIEF}\n\n${STORYTELLER_PROSE_RULES}`;

/** Narrator style modifier per persona id (balanced / chaotic). */
export const STORYTELLER_PERSONA_MODIFIERS: Record<string, string> = {
  balanced:
    'One main beat with maybe a sting in the last line. Echo the same moment across sentences rather than hopping from goblin to goblin.',
  chaotic:
    'Same single-thread rule, but the last line should be weird or unfairly funny; odd metaphor OK in one place only.',
};

const MAX_EVENT_LINES = 18;
const MAX_DETAILED_GOBLINS = 6;
const BIO_TRUNCATE = 110;
const MAX_PRIOR_CHAPTERS = 5;
const MAX_PRIOR_CHAPTER_TEXT_CHARS = 320;

/** Bounded prior-chapter excerpts for the user message (game + headless). */
export function formatPriorChaptersBlock(priorChapters: Chapter[]): string {
  if (priorChapters.length === 0) return '';
  const slice = priorChapters.slice(-MAX_PRIOR_CHAPTERS);
  const lines = slice.map(ch => {
    const t = ch.text.replace(/\s+/g, ' ').trim();
    const excerpt =
      t.length <= MAX_PRIOR_CHAPTER_TEXT_CHARS
        ? t
        : `${t.slice(0, MAX_PRIOR_CHAPTER_TEXT_CHARS - 1)}…`;
    return `- Chapter ${ch.chapterNumber}: ${excerpt}`;
  });
  return (
    `Chronicle so far (continuity only—do not retell; write this chapter from the milestone and key events below):\n` +
    `${lines.join('\n')}\n\n`
  );
}

const SYSTEM_ERROR_NAMES = new Set(['RAID', 'FIRE', 'STORM', 'WEATHER', 'WORLD', 'world', 'COLONY']);

/**
 * Humanize log speaker labels for chronicle context (prompt-only).
 * Colony goblins already appear under their own names; `GOBLIN` is the adventurer-combat log channel only.
 */
export function humanizeEventSpeaker(goblinName: string): string {
  if (goblinName === 'GOBLIN') {
    const p = getGoblinConfig().enemyNounPlural.trim();
    return p ? p[0]!.toUpperCase() + p.slice(1) : 'Adventurers';
  }
  const m: Record<string, string> = {
    COLONY: 'Colony',
    RAID: 'Raid',
    WEATHER: 'Weather',
    WORLD: 'World',
    world: 'World',
    FIRE: 'Fire',
    STORM: 'Storm',
  };
  return m[goblinName] ?? goblinName;
}

/** Strip numeric combat/skill UI from log lines sent to the LLM only. */
export function sanitizeLogMessageForStoryteller(message: string): string {
  let s = message;
  s = s.replace(/\([\d.]+\s*hp\)/gi, '(wounded)');
  s = s.replace(/\btook\s+\d+\s+hits?[^)]*\)/gi, match => match.replace(/\d+\s*hp\)/gi, 'wounded)'));
  s = s.replace(/\([\d.]+\s*hits?\s*taken[^)]*\)/gi, '(battered)');
  s = s.replace(/\b[\d.]+\s*hp\b/gi, '');
  s = s.replace(/\bLv\.\d+\b/gi, '');
  s = s.replace(/\[[A-Za-z]+\s*Lv\.\d+\]/gi, '');
  s = s.replace(/\s{2,}/g, ' ').replace(/\s+\)/g, ')').trim();
  return s;
}

function speakerLineCap(goblinName: string, level: LogEntry['level']): number {
  if (level === 'error') return 99;
  if (goblinName === 'WEATHER') return 2;
  if (goblinName === 'COLONY') return 3;
  if (goblinName === 'GOBLIN') return 4;
  if (SYSTEM_ERROR_NAMES.has(goblinName)) return 6;
  return 4;
}

function entryScore(e: LogEntry, killVerb: string): number {
  const msg = e.message;
  const name = e.goblinName;

  if (e.level === 'error') {
    if (name === 'RAID') return 96;
    if (!SYSTEM_ERROR_NAMES.has(name)) return 100;
    return 92;
  }
  if (name === 'RAID') return 95;
  if (name === 'WORLD' || name === 'world') return 90;
  if (msg.includes(killVerb)) return 88;
  if (name === 'FIRE' && e.level === 'warn') return 86;
  if (name === 'STORM') return 84;
  if (msg.includes('🩹') || msg.includes('suffered')) return 80;
  if (msg.includes('⚔') && e.level === 'warn') return 78;
  if (name === 'FIRE') return 72;
  if (name === 'COLONY') return 68;
  if (name === 'WEATHER') return 45;
  if (e.level === 'warn' && e.goblinId !== 'verify') return 40;
  return 25;
}

function dedupeKey(e: LogEntry): string {
  const bucket = Math.floor(e.tick / 30);
  return `${e.goblinName}|${bucket}|${e.message}`;
}

function formatEventLine(e: LogEntry): string {
  const label = humanizeEventSpeaker(e.goblinName);
  const msg = sanitizeLogMessageForStoryteller(e.message);
  return `[tick ${e.tick}] ${label}: ${msg}`;
}

/**
 * Pick impactful log lines since lastChapterTick (scored, capped, per-speaker quotas, sanitized for LLM).
 */
export function selectChapterEvents(logHistory: LogEntry[], lastChapterTick: number): string[] {
  const killVerb = getGoblinConfig().killVerb;
  const recent = logHistory.filter(e => e.tick > lastChapterTick);
  const scored = recent.map(e => ({ e, score: entryScore(e, killVerb) }));
  scored.sort((a, b) => b.score - a.score || b.e.tick - a.e.tick);

  const seen = new Set<string>();
  const perSpeaker = new Map<string, number>();
  const picked: LogEntry[] = [];

  for (const { e } of scored) {
    const k = dedupeKey(e);
    if (seen.has(k)) continue;
    const cap = speakerLineCap(e.goblinName, e.level);
    const n = perSpeaker.get(e.goblinName) ?? 0;
    if (n >= cap) continue;
    seen.add(k);
    perSpeaker.set(e.goblinName, n + 1);
    picked.push(e);
    if (picked.length >= MAX_EVENT_LINES) break;
  }
  picked.sort((a, b) => a.tick - b.tick);
  return picked.map(formatEventLine);
}

export interface BuildStorytellerPromptArgs {
  completedGoal: ColonyGoal;
  goblins: Goblin[];
  adventurers: Adventurer[];
  eventLines: string[];
  personaId: string;
  /**
   * If true, return one string: full system prompt + chapter context (for APIs with no system role, or copy-paste).
   * Game and normal headless use system + user separately—leave false.
   */
  legacySingleBlock?: boolean;
  /** Completed chronicle chapters before this one (game: scene.chapters at goal completion). */
  priorChapters?: Chapter[];
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function tensionGuidance(tension: number): string {
  if (tension > 70) {
    return 'high stakes—wry or absurd angle; never nihilistic';
  }
  if (tension < 30) {
    return 'relative calm—small triumphs and gentle comedy';
  }
  return 'uneasy calm—fortunes mixed; something always feels one step from going wrong';
}

/**
 * User message: facts + persona + task (system prompt carries voice and global rules).
 */
export function buildStorytellerUserPrompt(args: BuildStorytellerPromptArgs): string {
  const { completedGoal, goblins, adventurers, eventLines, personaId, legacySingleBlock, priorChapters } =
    args;
  const cfg = getGoblinConfig();
  const alive = goblins.filter(d => d.alive);
  const dead = goblins.filter(d => !d.alive);

  const avgHunger =
    alive.length > 0 ? alive.reduce((s, d) => s + d.hunger, 0) / alive.length : 100;
  const avgMorale =
    alive.length > 0 ? alive.reduce((s, d) => s + d.morale, 0) / alive.length : 0;
  const tension = Math.min(
    100,
    avgHunger + (100 - avgMorale) * 0.5 + adventurers.length * 15 + dead.length * 20,
  );

  const personaMod =
    STORYTELLER_PERSONA_MODIFIERS[personaId] ?? STORYTELLER_PERSONA_MODIFIERS['balanced'];

  const chapterNum = completedGoal.generation + 1;

  const rosterLines: string[] = [];
  alive.slice(0, MAX_DETAILED_GOBLINS).forEach(g => {
    const traitLabel = cfg.traitDisplay[g.trait] ?? g.trait;
    rosterLines.push(
      `- ${g.name} (${traitLabel}): "${truncate(g.bio, BIO_TRUNCATE)}" | wants: ${truncate(g.goal, 80)}`,
    );
  });
  if (alive.length > MAX_DETAILED_GOBLINS) {
    const rest = alive.slice(MAX_DETAILED_GOBLINS);
    rosterLines.push(
      `- Also alive: ${rest.map(g => `${g.name} (${cfg.traitDisplay[g.trait] ?? g.trait})`).join(', ')}`,
    );
  }

  const deathLines = extractChapterDeaths(eventLines);
  const deathBlock =
    deathLines.length > 0
      ? `\nLosses this chapter:\n${deathLines.map(d => `- ${d}`).join('\n')}`
      : '';

  const eventBlock =
    eventLines.length > 0
      ? `\nKey events this chapter:\n${eventLines.join('\n')}`
      : '\nA quiet chapter with no major events logged.';

  const priorBlock = formatPriorChaptersBlock(priorChapters ?? []);

  const core =
    `Narrator mode: ${personaMod}\n\n` +
    priorBlock +
    `Write the chapter summary for Chapter ${chapterNum}. ` +
    `Use at most three colonist names; prioritize goblins who actually appear in the key events.\n\n` +
    `Milestone just completed: ${completedGoal.description}\n` +
    `Colony: ${alive.length} ${cfg.unitNounPlural} alive, ${dead.length} fallen total.${deathBlock}\n\n` +
    `Roster (alive):\n${rosterLines.length > 0 ? rosterLines.join('\n') : '(none)'}\n` +
    `Mood for prose: ${tensionGuidance(tension)} (tension ${tension.toFixed(0)}/100).\n` +
    `${eventBlock}`;

  if (legacySingleBlock) {
    return (
      `${STORYTELLER_SYSTEM_PROMPT}\n\n--- Chapter context ---\n\n` +
      core +
      `\n\nFollow all rules above. No dialogue.`
    );
  }

  return `${core}\n\nFollow the system rules (especially: no Meanwhile; one thread; no invented scenery). No dialogue.`;
}

function extractChapterDeaths(eventLines: string[]): string[] {
  const out: string[] = [];
  for (const line of eventLines) {
    const lo = line.toLowerCase();
    if (lo.includes('killed') || lo.includes('died') || lo.includes('dead')) {
      const m = line.match(/\] ([^:]+): (.+)/);
      if (m) out.push(`${m[1]}: ${m[2]}`);
    }
  }
  return [...new Set(out)].slice(0, 8);
}
