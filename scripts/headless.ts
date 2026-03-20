/**
 * Headless simulation harness — runs the full Kobold sim without Phaser/React.
 * Uses the same simulation APIs (world, utilityAI, diffusion, fire, adventurers, etc.)
 * with a minimal harness: fixed rooms/stockpiles, no UI. Used for tuning (action
 * frequencies, need drift) and regression runs (see AGENTS.md headless section).
 *
 * Usage:
 *   npx tsx scripts/headless.ts [ticks] [seed]
 *
 * Examples:
 *   npx tsx scripts/headless.ts              # 2000 ticks, random seed
 *   npx tsx scripts/headless.ts 5000         # 5000 ticks
 *   npx tsx scripts/headless.ts 2000 42      # reproducible run with seed 42
 *
 * Output: summary table + action frequency bar chart + trait bias + oscillation log.
 * Optional JSON dump: DUMP_JSON=1 npx tsx scripts/headless.ts 1000
 *
 * Storyteller prompt dry-run (per goal completion):
 *   HEADLESS_STORY=1 npx tsx scripts/headless.ts 3000
 *   npm run headless:story                    # --story + default tick count
 *   npm run headless -- 3000 42 --story       # npm needs -- before script flags
 *   npx tsx scripts/headless.ts 3000 --story --story-persona=chaotic
 * Optional LLM (needs GROQ_API_KEY or ANTHROPIC_API_KEY): HEADLESS_STORY_LLM=1
 *
 * Story cadence: default --story-every=800 (timed beats). Use --story-every=0 for goals only.
 * --story-real-goals: seed kitchen + wood so cook_meals can complete (authentic goal text).
 */

import { generateWorld, growback } from '../src/simulation/world';
import { tickFire, tickBurningGoblins } from '../src/simulation/fire';
import { tickLightning } from '../src/simulation/lightning';
import { tickPooling } from '../src/simulation/pooling';
import { spawnGoblins, spawnSuccessor, SUCCESSION_DELAY } from '../src/simulation/agents';
import { tickAgentUtility } from '../src/simulation/utilityAI';
import { maybeSpawnRaid, tickAdventurers, resetAdventurers, spawnInitialAdventurers } from '../src/simulation/adventurers';
import { resetChickens, spawnInitialChickens, tickChickens, tickNurseryPenEggs } from '../src/simulation/chickens';
import { createDangerField, computeGoblinWarmth, computeDanger, updateTraffic } from '../src/simulation/diffusion';
import { createWeather, tickWeather, growbackModifier, metabolismModifier } from '../src/simulation/weather';
import { tickWorldEvents, setNextEventTick } from '../src/simulation/events';
import { expandStockpilesInRooms, expandLumberHutWoodStockpiles, expandBlacksmithOreStockpiles, clearRoomGroundToDirt } from '../src/simulation/rooms';
import { rollWound, woundLabel } from '../src/simulation/wounds';
import { topSkill } from '../src/simulation/skills';
import { getGoblinConfig } from '../src/shared/goblinConfig';
import { buildFallbackChapter } from '../src/ai/storyteller';
import {
  STORYTELLER_SYSTEM_PROMPT,
  buildStorytellerUserPrompt,
  selectChapterEvents,
} from '../src/ai/storytellerPrompt';
import { GRID_SIZE, HEARTH_FUEL_MAX } from '../src/shared/constants';
import type {
  Goblin,
  FoodStockpile,
  MealStockpile,
  OreStockpile,
  WoodStockpile,
  PlankStockpile,
  BarStockpile,
  ColonyGoal,
  Chapter,
  Adventurer,
  Chicken,
  Room,
  LogEntry,
} from '../src/shared/types';
import { TileType } from '../src/shared/types';
import { FORAGEABLE_TILES } from '../src/simulation/agents/sites';

// ── CLI args ──────────────────────────────────────────────────────────────────
// Numeric args (any order vs flags): first number = ticks (default 2000), second = optional seed.
// e.g. headless.ts --story | headless.ts 4000 --story | headless.ts --story 4000 42

type HeadlessCliConfig = {
  ticks: number;
  seedArg: number | undefined;
  dumpJson: boolean;
  headlessStory: boolean;
  headlessStoryPersona: string;
  storyEveryTicks: number;
  headlessStoryRealGoals: boolean;
  headlessStoryLlm: boolean;
};

function parseHeadlessCli(args: string[], env: NodeJS.ProcessEnv): HeadlessCliConfig {
  const numericArgs = args.filter(a => /^\d+$/.test(a)).map(n => parseInt(n, 10));
  let ticks = numericArgs[0] ?? 2000;
  if (!Number.isFinite(ticks) || ticks < 1) ticks = 2000;
  const seedArg = numericArgs.length > 1 ? numericArgs[1] : undefined;
  const dumpJson = env['DUMP_JSON'] === '1';

  let headlessStory = env['HEADLESS_STORY'] === '1';
  let headlessStoryPersona = 'balanced';
  let storyEveryFromCli: number | undefined;
  let headlessStoryRealGoals = env['HEADLESS_STORY_REAL_GOALS'] === '1';
  for (const a of args) {
    if (a === '--story') headlessStory = true;
    if (a.startsWith('--story-persona=')) {
      headlessStoryPersona = a.slice('--story-persona='.length).trim() || 'balanced';
    }
    if (a.startsWith('--story-every=')) {
      const n = parseInt(a.slice('--story-every='.length), 10);
      if (Number.isFinite(n) && n >= 0) storyEveryFromCli = n;
    }
    if (a === '--story-real-goals') headlessStoryRealGoals = true;
  }
  let storyEveryTicks = 0;
  if (headlessStory) {
    if (storyEveryFromCli !== undefined) {
      storyEveryTicks = storyEveryFromCli;
    } else {
      const envN = env['HEADLESS_STORY_EVERY'];
      if (envN !== undefined && envN !== '') {
        const n = parseInt(envN, 10);
        storyEveryTicks = Number.isFinite(n) && n >= 0 ? n : 800;
      } else {
        storyEveryTicks = 800;
      }
    }
  }

  return {
    ticks,
    seedArg,
    dumpJson,
    headlessStory,
    headlessStoryPersona,
    storyEveryTicks,
    headlessStoryRealGoals,
    headlessStoryLlm: env['HEADLESS_STORY_LLM'] === '1',
  };
}

const cli = parseHeadlessCli(process.argv.slice(2), process.env);
const TICKS = cli.ticks;
const SEED_ARG = cli.seedArg;
const DUMP_JSON = cli.dumpJson;
const headlessStory = cli.headlessStory;
const headlessStoryPersona = cli.headlessStoryPersona;
const storyEveryTicks = cli.storyEveryTicks;
const headlessStoryRealGoals = cli.headlessStoryRealGoals;
const headlessStoryLlm = cli.headlessStoryLlm;
const storyLlmPrompts: { system: string; user: string }[] = [];
/** Synthetic chronicle entries so storyteller prompts match in-game continuity (prior chapters). */
const headlessChapters: Chapter[] = [];

// Headless reporting constants (tuning / output shape)
const SNAPSHOT_INTERVAL = 10;
const TOP_ACTIONS_COUNT = 15;
const MIN_TRAIT_TICKS = 50;
const BAR_WIDTH = 20;
const SPAWN_NEAR_RADIUS = 30;

// ── Stats (recording buffers) ─────────────────────────────────────────────────
// These are filled during the tick loop and printed in the report section.

interface TickSnapshot {
  tick: number;
  alive: number;
  totalFood: number;
  totalOre: number;
  totalWood: number;
  avgHunger: number;
  avgMorale: number;
  avgFatigue: number;
  raiders: number;
}

const snapshots: TickSnapshot[] = [];
const actionCounts: Record<string, number> = {};
/** Per-trait action counts for trait-bias validation (brave vs flee, lazy rest, etc.) */
const actionCountsByTrait: Record<string, Record<string, number>> = {};
const deathLog: { tick: number; name: string; cause: string }[] = [];
const raidLog: { tick: number; count: number }[] = [];
const goalLog: { tick: number; type: string; generation: number }[] = [];
const warnLog: { tick: number; name: string; message: string }[] = [];
const fireLog: { tick: number; level: 'info' | 'warn' | 'error'; message: string }[] = [];
const oscillationLog: Array<{
  tick: number;
  name: string;
  trait: string;
  task: string;
  positions: string[];
  tasks: string[];  // unique tasks during oscillation
}> = [];
/** Chronicle-shaped log for storyteller prompt (mirrors game logHistory windows). */
const logHistory: LogEntry[] = [];
let lastChapterTick = 0;
let headlessStoryBeatIndex = 0;
let fireTilesMax = 0;  // peak simultaneous fire tile count
let fireTilesTotal = 0;  // cumulative tiles that burned or were extinguished
let fireTilesRainedOut = 0;  // tiles extinguished by rain

/** Rough input size for storyteller system+user (~4 chars/token; proxy body cap 48k). */
function formatStoryPromptSize(system: string, user: string): string {
  const chars = system.length + user.length;
  const tok = Math.ceil(chars / 4);
  const cap = 48_000;
  const limitNote =
    chars <= cap ? `under ${cap.toLocaleString()} char proxy limit` : `over ${cap.toLocaleString()} char limit (may 413)`;
  return `~${tok.toLocaleString()} tokens (est.) · ${chars.toLocaleString()} chars · ${limitNote}`;
}

/** Normalize raw task string to a short bucket label for the action frequency table (e.g. "→ kitchen" → "traveling to kitchen"). */
function normalizeTaskLabel(task: string): string {
  if (task.startsWith('→')) {
    const match = task.match(/→\s*([a-z]+)/);
    return match ? `traveling to ${match[1]}` : 'traveling';
  }
  return task.replace(/\s*[(→].*/, '').trim() || 'idle';
}

/** Record one goblin-tick's action into global actionCounts and actionCountsByTrait for the report. */
function recordAction(goblin: Goblin, task: string) {
  const key = normalizeTaskLabel(task);
  actionCounts[key] = (actionCounts[key] ?? 0) + 1;
  const trait = goblin.trait;
  if (!actionCountsByTrait[trait]) actionCountsByTrait[trait] = {};
  actionCountsByTrait[trait][key] = (actionCountsByTrait[trait][key] ?? 0) + 1;
}

/** Sum action counts; optional keyPredicate limits to keys matching a predicate (e.g. rest/fight/flee). */
function sumActionCounts(counts: Record<string, number>, keyPredicate?: (key: string) => boolean): number {
  if (!keyPredicate) return Object.values(counts).reduce((a, b) => a + b, 0);
  return Object.entries(counts).reduce((s, [k, v]) => (keyPredicate(k) ? s + v : s), 0);
}

/** Log world seed and harvestable tile stats at startup. */
function logHeadlessInit(seed: string, forageableNearSpawn: number, totalForageable: number): void {
  console.log(`   World seed: ${seed}`);
  console.log(`   Harvestable: ${forageableNearSpawn} tiles within ${SPAWN_NEAR_RADIUS} of spawn`);
  console.log(`   Total: ${totalForageable} ${[...FORAGEABLE_TILES].join('/')} tiles across ${GRID_SIZE}x${GRID_SIZE} map`);
}

// ── Goal helpers ──────────────────────────────────────────────────────────────
// Contract: keep in sync with src/game/scenes/WorldGoals.ts (makeGoal scale/targets)
// and goal progress (cook_meals = meal count, survive_ticks = tick delta, defeat_adventurers = kill count).
// Headless uses a subset cycle (no build_rooms) and tracks progress from stockpiles/tick/kills.

type GoalType = ColonyGoal['type'];
const GOAL_CYCLE: GoalType[] = ['cook_meals', 'survive_ticks', 'defeat_adventurers'];

/** Build a colony goal with scaled target; scale increases per generation so later goals are harder. */
function makeGoal(type: GoalType, generation: number): ColonyGoal {
  const scale = 1 + generation * 0.6;
  const desc = getGoblinConfig().goalDescriptions;
  switch (type) {
    case 'cook_meals': {
      let target = Math.round(20 * scale);
      if (headlessStoryRealGoals && generation === 0) target = Math.min(8, target);
      return { type, description: desc.cook_meals(target), progress: 0, target, generation };
    }
    case 'survive_ticks': return { type, description: desc.survive_ticks(Math.round(400 * scale)), progress: 0, target: Math.round(400 * scale), generation };
    case 'defeat_adventurers': return { type, description: desc.defeat_adventurers(Math.round(5 * scale)), progress: 0, target: Math.round(5 * scale), generation };
  }
  return { type: 'cook_meals' as const, description: '', progress: 0, target: 20, generation };
}

// ── Init ──────────────────────────────────────────────────────────────────────
// Build world, spawn agents, set up rooms/stockpiles/hearth and diffusion state.
// No Phaser/React — same simulation APIs as the game, with a minimal harness.

console.log(`\n🧌 Kobold headless sim — ${TICKS} ticks${SEED_ARG !== undefined ? `, seed ${SEED_ARG}` : ''}\n`);

const { grid, spawnZone, seed } = generateWorld(SEED_ARG?.toString());
resetChickens();

// Count harvestable tiles (forageable near spawn and total) for startup diagnostics.
let totalForageable = 0;
let forageableNearSpawn = 0;
const spawnCx = spawnZone.x + Math.floor(spawnZone.w / 2);
const spawnCy = spawnZone.y + Math.floor(spawnZone.h / 2);
for (let y = 0; y < GRID_SIZE; y++) {
  for (let x = 0; x < GRID_SIZE; x++) {
    if (FORAGEABLE_TILES.has(grid[y][x].type)) {
      totalForageable++;
      const dist = Math.sqrt((x - spawnCx) ** 2 + (y - spawnCy) ** 2);
      if (dist < SPAWN_NEAR_RADIUS) forageableNearSpawn++;
    }
  }
}
logHeadlessInit(seed, forageableNearSpawn, totalForageable);
if (headlessStory) {
  if (storyEveryTicks > 0) {
    console.log(
      `   Story prompts: every ${storyEveryTicks} ticks + on goal complete (use --story-every=0 for goals only)`,
    );
  } else {
    console.log(`   Story prompts: on goal complete only (--story-every=0)`);
  }
}
if (headlessStoryRealGoals) {
  console.log(`   Story real goals: kitchen + wood seeded; first cook_meals target ≤8`);
}

const goblins: Goblin[] = spawnGoblins(grid, spawnZone);
let adventurers: Adventurer[] = spawnInitialAdventurers(grid, 3);
const chickens: Chicken[] = spawnInitialChickens(grid, 8);
resetAdventurers();

const depotX = Math.floor(spawnZone.x + spawnZone.w / 2);
const depotY = Math.floor(spawnZone.y + spawnZone.h / 2);

// Starter layout: one storage room near spawn, matching GUI new-colony flow (no kitchen/lumber_hut/blacksmith).
const storageRoom: Room = { id: 'room-storage', type: 'storage', x: depotX - 2, y: depotY - 2, w: 5, h: 5 };
const rooms: Room[] = [storageRoom];

// Place a hearth a short walk from spawn so warmth/diffusion behave similarly to the main game.
const hearthCell = grid[depotY + 8][depotX + 8];
grid[depotY + 8][depotX + 8] = { ...hearthCell, type: TileType.Hearth, foodValue: 0, maxFood: 0, materialValue: 0, maxMaterial: 0, growbackRate: 0, hearthFuel: HEARTH_FUEL_MAX };

// Stockpiles: start with a single empty food stockpile in storage; other piles will be established by actions.
const foodStockpiles: FoodStockpile[] = [{ x: storageRoom.x + 1, y: storageRoom.y + 1, food: 0, maxFood: 200 }];
const mealStockpiles: MealStockpile[] = [];
const oreStockpiles: OreStockpile[] = [];
const woodStockpiles: WoodStockpile[] = [];
const plankStockpiles: PlankStockpile[] = [];
const barStockpiles: BarStockpile[] = [];

if (headlessStoryRealGoals) {
  const hx = depotX + 8;
  const hy = depotY + 8;
  const kx = hx - 4;
  const ky = hy - 2;
  clearRoomGroundToDirt(grid, kx, ky, 5, 5);
  rooms.push({ id: 'room-kitchen-headless', type: 'kitchen', x: kx, y: ky, w: 5, h: 5 });
  mealStockpiles.push({ x: kx + 1, y: ky + 1, meals: 0, maxMeals: 200 });
  woodStockpiles.push({
    x: storageRoom.x + 2,
    y: storageRoom.y + 2,
    wood: 80,
    maxWood: 200,
  });
}

for (const g of goblins) {
  g.homeTile = { x: depotX, y: depotY };
}

let colonyGoal = makeGoal('cook_meals', 0);
let goalStartTick = 0;
let adventurerKills = 0;
const pendingSuccessions: { deadGoblinId: string; spawnAtTick: number }[] = [];
const combatHits = new Map<string, number>();

const weather = createWeather(0);
const dangerField = createDangerField();
const dangerPrev = createDangerField();

setNextEventTick(300 + Math.floor(Math.random() * 300));

// ── Oscillation tracking ──────────────────────────────────────────────────────
// Per-goblin position/task history; used to detect agents cycling among few tiles (e.g. A↔B↔C).
const posHistory = new Map<string, Array<{x: number, y: number, task: string}>>();
const HISTORY_LEN = 20;  // ticks of history to keep
const OSCILLATION_THRESHOLD = 10;  // min ticks in loop to flag
const MAX_UNIQUE_POSITIONS = 3;  // flag if cycling among ≤ this many tiles

// ── Simulation tick steps ──────────────────────────────────────────────────────
// Each function runs one part of the tick. Order matches game logic: weather → diffusion → agents → fire/env → raids → events → succession → stockpiles → goal/snapshot.

function runWeatherTick(tick: number): void {
  const wmsg = tickWeather(weather, tick);
  if (wmsg) {
    logHistory.push({
      tick,
      goblinId: 'system',
      goblinName: 'WEATHER',
      message: wmsg,
      level: 'info',
    });
  }
}

/** Per-goblin warmth (shelter-style); danger from adventurers; traffic. */
function runDiffusionTick(tick: number): void {
  computeDanger(grid, adventurers, dangerPrev, dangerField);
  dangerPrev.set(dangerField);
  updateTraffic(grid, goblins);
  tickChickens(chickens, grid, goblins, rooms);
  tickNurseryPenEggs(chickens, rooms, grid, tick);
  for (const g of goblins) {
    if (g.alive) {
      const raw = computeGoblinWarmth(g, grid, rooms, weather.type);
      g.warmth = (g.warmth ?? raw) * 0.95 + raw * 0.05;
    }
  }
}

/** Run utility AI for each goblin; record action and log death/succession when one just died. */
function runAgentTicks(tick: number): void {
  for (const g of goblins) {
    const wasAlive = g.alive;
    tickAgentUtility(
      g, grid, tick, goblins,
      (message, level) => {
        if (level === 'warn' || level === 'error') {
          warnLog.push({ tick, name: g.name, message });
          logHistory.push({
            tick,
            goblinId: g.id,
            goblinName: g.name,
            message,
            level,
          });
        }
      },
      foodStockpiles, adventurers, oreStockpiles, colonyGoal, woodStockpiles,
      metabolismModifier(weather), dangerField, weather.type, rooms, mealStockpiles,
      plankStockpiles, barStockpiles,
      chickens,
    );
    if (g.alive) recordAction(g, g.task);
    if (wasAlive && !g.alive) {
      deathLog.push({ tick, name: g.name, cause: g.causeOfDeath ?? 'unknown' });
      pendingSuccessions.push({ deadGoblinId: g.id, spawnAtTick: tick + SUCCESSION_DELAY });
    }
  }
}

/** Append current position/task to history; if recent history has ≤MAX_UNIQUE_POSITIONS unique tiles, log oscillation. */
function recordOscillation(tick: number): void {
  for (const g of goblins) {
    if (!g.alive) continue;
    const hist = posHistory.get(g.id) ?? [];
    hist.push({ x: g.x, y: g.y, task: g.task });
    if (hist.length > HISTORY_LEN) hist.shift();
    posHistory.set(g.id, hist);

    // Oscillation = cycling among few tiles in the last OSCILLATION_THRESHOLD ticks.
    if (hist.length >= OSCILLATION_THRESHOLD) {
      const recent = hist.slice(-OSCILLATION_THRESHOLD);
      const uniquePos = new Set(recent.map(p => `${p.x},${p.y}`));
      const uniqueTasks = new Set(recent.map(p => normalizeTaskLabel(p.task)));
      if (uniquePos.size <= MAX_UNIQUE_POSITIONS) {
        oscillationLog.push({
          tick,
          name: g.name,
          trait: g.trait,
          task: g.task,
          positions: [...uniquePos],
          tasks: [...uniqueTasks],
        });
      }
    }
  }
}

/** Burning goblins, growback, pooling, lightning, fire spread; accumulate fire stats for report. */
function runFireAndEnvironment(tick: number): void {
  const fireStory = (msg: string, level: 'info' | 'warn' | 'error') => {
    fireLog.push({ tick, level, message: msg });
    logHistory.push({ tick, goblinId: 'world', goblinName: 'FIRE', message: msg, level });
  };
  const stormStory = (msg: string, level: 'info' | 'warn' | 'error') => {
    fireLog.push({ tick, level, message: msg });
    logHistory.push({ tick, goblinId: 'world', goblinName: 'STORM', message: msg, level });
  };
  tickBurningGoblins(grid, tick, goblins, fireStory);
  growback(grid, growbackModifier(weather), tick);
  tickPooling(grid, tick, weather.type);
  tickLightning(grid, tick, weather.type, stormStory);
  const fireResult = tickFire(grid, tick, goblins, weather.type, fireStory);
  fireTilesTotal += fireResult.burnouts;
  fireTilesRainedOut += fireResult.extinguished;

  let fireTileCount = 0;
  for (let fy = 0; fy < GRID_SIZE; fy++)
    for (let fx = 0; fx < GRID_SIZE; fx++)
      if (grid[fy][fx].type === TileType.Fire) fireTileCount++;
  if (fireTileCount > fireTilesMax) fireTilesMax = fireTileCount;
}

/** Maybe spawn a raid (log to raidLog); tick adventurers, apply damage/wounds, log deaths and schedule succession. */
function runRaidsAndCombat(tick: number): void {
  const gcfg = getGoblinConfig();
  const enemyNoun = gcfg.enemyNounPlural;
  const enemySing = enemyNoun.replace(/s$/, '');

  const raid = maybeSpawnRaid(grid, goblins, tick);
  if (raid) {
    adventurers.push(...raid.adventurers);
    raidLog.push({ tick, count: raid.count });
    logHistory.push({
      tick,
      goblinId: 'adventurer',
      goblinName: 'RAID',
      message: `⚔ ${raid.count} ${enemyNoun} storm from the ${raid.edge} !${gcfg.raidSuffix} `,
      level: 'error',
    });
  }

  if (adventurers.length > 0) {
    const gr = tickAdventurers(adventurers, goblins, grid, tick);
    for (const { goblinId, damage } of gr.attacks) {
      const g = goblins.find(d => d.id === goblinId);
      if (g && g.alive) {
        g.health = Math.max(0, g.health - damage);
        g.morale = Math.max(0, g.morale - 5);
        if (g.health <= 0) {
          g.alive = false;
          g.task = 'dead';
          g.causeOfDeath = `killed by ${enemyNoun}`;
          deathLog.push({ tick, name: g.name, cause: g.causeOfDeath });
          logHistory.push({
            tick,
            goblinId: g.id,
            goblinName: g.name,
            message: `killed by ${enemyNoun}!`,
            level: 'error',
          });
          pendingSuccessions.push({ deadGoblinId: g.id, spawnAtTick: tick + SUCCESSION_DELAY });
        } else {
          const hits = (combatHits.get(g.id) ?? 0) + 1;
          combatHits.set(g.id, hits);
          if (hits % 3 === 1) {
            logHistory.push({
              tick,
              goblinId: g.id,
              goblinName: g.name,
              message:
                hits === 1
                  ? `⚔ hit by ${enemySing} !(${g.health.toFixed(0)} hp)`
                  : `⚔ fighting ${enemySing} (${hits} hits taken, ${g.health.toFixed(0)} hp)`,
              level: 'warn',
            });
          }
          const w = rollWound(g, tick);
          if (w) {
            g.wound = w;
            logHistory.push({
              tick,
              goblinId: g.id,
              goblinName: g.name,
              message: `🩹 suffered a ${woundLabel(w.type)} !`,
              level: 'warn',
            });
          }
        }
      }
    }

    for (const { message, level } of gr.logs) {
      logHistory.push({
        tick,
        goblinId: 'adventurer',
        goblinName: 'GOBLIN',
        message,
        level,
      });
    }

    if (gr.adventurerDeaths.length > 0) {
      const article = /^[aeiou]/i.test(enemySing) ? 'an' : 'a';
      for (const { goblinId } of gr.kills) {
        const killer = goblins.find(dw => dw.id === goblinId && dw.alive);
        if (killer) {
          killer.adventurerKills += 1;
          const hitsTaken = combatHits.get(killer.id) ?? 0;
          combatHits.delete(killer.id);
          logHistory.push({
            tick,
            goblinId: killer.id,
            goblinName: killer.name,
            message:
              hitsTaken > 0
                ? `⚔ ${gcfg.killVerb} ${article} ${enemySing} !(took ${hitsTaken} hits, ${killer.health.toFixed(0)} hp)`
                : `⚔ ${gcfg.killVerb} ${article} ${enemySing} !`,
            level: 'warn',
          });
        }
      }
    }

    adventurerKills += gr.adventurerDeaths.length;
    const deadIds = new Set(gr.adventurerDeaths);
    adventurers = adventurers.filter(a => !deadIds.has(a.id));
    combatHits.forEach((_, id) => {
      if (deadIds.has(id)) combatHits.delete(id);
    });
  }
}

/** World events; then process pending successions (spawn replacement goblins after SUCCESSION_DELAY). */
function runWorldEventsAndSuccession(tick: number): void {
  const ev = tickWorldEvents(grid, tick, goblins, adventurers);
  if (ev.fired) {
    logHistory.push({
      tick,
      goblinId: 'world',
      goblinName: 'WORLD',
      message: ev.message,
      level: 'warn',
    });
  }

  // At tick 400, add a lumber hut near storage so headless matches a mid-game GUI where the player
  // has built their first wood-processing room. This lets us observe chop/saw/wood stockpiling.
  if (tick === 400) {
    const lumberX = storageRoom.x - 8;
    const lumberY = storageRoom.y;
    clearRoomGroundToDirt(grid, lumberX, lumberY, 5, 5);
    const lumberRoom: Room = {
      id: 'room-lumber',
      type: 'lumber_hut',
      x: lumberX,
      y: lumberY,
      w: 5,
      h: 5,
    };
    rooms.push(lumberRoom);
    // Match GUI: place an initial empty wood stockpile at (x+1,y+1) inside the lumber hut.
    woodStockpiles.push({ x: lumberX + 1, y: lumberY + 1, wood: 0, maxWood: 200 });
  }

  for (let i = pendingSuccessions.length - 1; i >= 0; i--) {
    const s = pendingSuccessions[i];
    if (tick < s.spawnAtTick) continue;
    pendingSuccessions.splice(i, 1);
    const dead = goblins.find(g => g.id === s.deadGoblinId);
    if (!dead) continue;
    const successor = spawnSuccessor(dead, grid, spawnZone, goblins, tick);
    const home = foodStockpiles[0] ?? { x: depotX, y: depotY };
    successor.homeTile = { x: home.x, y: home.y };
    goblins.push(successor);
    successor.memory.push({ tick, crisis: 'arrival', action: `arrived to replace ${dead.name}` });
    const skill = topSkill(successor);
    const skillLabel = skill ? `[${skill.skill.toUpperCase()} Lv.${skill.level}]` : '';
    logHistory.push({
      tick,
      goblinId: successor.id,
      goblinName: successor.name,
      message: `arrives to take ${dead.name}'s place. ${skillLabel}`,
      level: 'info',
    });
  }
}

/** Expand storage/lumber/blacksmith stockpiles when rooms qualify (callbacks are no-op; no UI). */
function runStockpileExpansion(): void {
  const noop = () => {};
  expandStockpilesInRooms(
    grid, rooms, foodStockpiles, oreStockpiles, woodStockpiles,
    noop, noop, noop,
  );
  expandLumberHutWoodStockpiles(grid, rooms, foodStockpiles, oreStockpiles, woodStockpiles, noop);
  expandBlacksmithOreStockpiles(grid, rooms, foodStockpiles, oreStockpiles, woodStockpiles, noop);
}

/** Update goal progress from stockpiles/tick/kills; on completion bump morale, cycle to next goal, push to goalLog. Every SNAPSHOT_INTERVAL ticks push a snapshot for need drift / final report. */
function runGoalProgressAndSnapshot(tick: number): void {
  const aliveNow = goblins.filter(g => g.alive);
  let goalCompletedThisTick = false;
  switch (colonyGoal.type) {
    case 'cook_meals': colonyGoal.progress = mealStockpiles.reduce((s, d) => s + d.meals, 0); break;
    case 'survive_ticks': colonyGoal.progress = tick - goalStartTick; break;
    case 'defeat_adventurers': colonyGoal.progress = adventurerKills; break;
  }
  if (colonyGoal.progress >= colonyGoal.target) {
    goalCompletedThisTick = true;
    const completedGoal: ColonyGoal = {
      type: colonyGoal.type,
      description: colonyGoal.description,
      progress: colonyGoal.progress,
      target: colonyGoal.target,
      generation: colonyGoal.generation,
    };
    for (const g of aliveNow) g.morale = Math.min(100, g.morale + 15);
    goalLog.push({ tick, type: colonyGoal.type, generation: colonyGoal.generation });
    logHistory.push({
      tick,
      goblinId: 'world',
      goblinName: 'COLONY',
      message: `✓ Goal complete: ${colonyGoal.description}! Morale boost for all!`,
      level: 'info',
    });

    if (headlessStory) {
      const eventLines = selectChapterEvents(logHistory, lastChapterTick);
      const user = buildStorytellerUserPrompt({
        completedGoal,
        goblins,
        adventurers,
        eventLines,
        personaId: headlessStoryPersona,
        priorChapters: [...headlessChapters],
      });
      console.log(
        `\n${'═'.repeat(60)}\nHEADLESS STORY PROMPT (goal: ${completedGoal.type} gen ${completedGoal.generation})\n${formatStoryPromptSize(STORYTELLER_SYSTEM_PROMPT, user)}\n${'═'.repeat(60)}\n--- system ---\n${STORYTELLER_SYSTEM_PROMPT}\n\n--- user ---\n${user}\n`,
      );
      if (headlessStoryLlm) storyLlmPrompts.push({ system: STORYTELLER_SYSTEM_PROMPT, user });
      const chNum = headlessChapters.length + 1;
      headlessChapters.push({
        chapterNumber: chNum,
        goalType: completedGoal.type,
        goalGeneration: completedGoal.generation,
        text: buildFallbackChapter(completedGoal, aliveNow, eventLines),
        tick,
      });
    }
    lastChapterTick = tick; // chapter window for next goal (matches game lastChapterTick)

    const curr = GOAL_CYCLE.indexOf(colonyGoal.type);
    const next = GOAL_CYCLE[(curr + 1) % GOAL_CYCLE.length];
    if (next === 'defeat_adventurers') adventurerKills = 0;
    goalStartTick = tick;
    colonyGoal = makeGoal(next, colonyGoal.generation + 1);
  }

  if (
    headlessStory &&
    storyEveryTicks > 0 &&
    tick > 0 &&
    tick % storyEveryTicks === 0 &&
    !goalCompletedThisTick
  ) {
    const beatStart = lastChapterTick + 1;
    const syntheticGoal: ColonyGoal = {
      type: 'survive_ticks',
      description: `Headless story beat: ticks ${beatStart}–${tick} (beat ${headlessStoryBeatIndex + 1})`,
      progress: storyEveryTicks,
      target: storyEveryTicks,
      generation: headlessStoryBeatIndex,
    };
    headlessStoryBeatIndex += 1;
    const eventLines = selectChapterEvents(logHistory, lastChapterTick);
    const user = buildStorytellerUserPrompt({
      completedGoal: syntheticGoal,
      goblins,
      adventurers,
      eventLines,
      personaId: headlessStoryPersona,
      priorChapters: [...headlessChapters],
    });
    console.log(
      `\n${'═'.repeat(60)}\nHEADLESS STORY PROMPT (timed beat ${syntheticGoal.generation + 1}, ticks ${beatStart}–${tick})\n${formatStoryPromptSize(STORYTELLER_SYSTEM_PROMPT, user)}\n${'═'.repeat(60)}\n--- system ---\n${STORYTELLER_SYSTEM_PROMPT}\n\n--- user ---\n${user}\n`,
    );
    if (headlessStoryLlm) storyLlmPrompts.push({ system: STORYTELLER_SYSTEM_PROMPT, user });
    const chNum = headlessChapters.length + 1;
    headlessChapters.push({
      chapterNumber: chNum,
      goalType: syntheticGoal.type,
      goalGeneration: syntheticGoal.generation,
      text: buildFallbackChapter(syntheticGoal, aliveNow, eventLines),
      tick,
    });
    lastChapterTick = tick;
  }

  if (tick % SNAPSHOT_INTERVAL === 0) {
    snapshots.push({
      tick,
      alive: aliveNow.length,
      totalFood: foodStockpiles.reduce((s, d) => s + d.food, 0),
      totalOre: oreStockpiles.reduce((s, d) => s + d.ore, 0),
      totalWood: woodStockpiles.reduce((s, d) => s + d.wood, 0),
      avgHunger: aliveNow.length ? aliveNow.reduce((s, g) => s + g.hunger, 0) / aliveNow.length : 0,
      avgMorale: aliveNow.length ? aliveNow.reduce((s, g) => s + g.morale, 0) / aliveNow.length : 0,
      avgFatigue: aliveNow.length ? aliveNow.reduce((s, g) => s + g.fatigue, 0) / aliveNow.length : 0,
      raiders: adventurers.length,
    });
  }
}

/** Runs one full simulation tick. runAgentTicks also records action counts and death/succession; recordOscillation runs after agents. */
function runSimulationTick(tick: number): void {
  runWeatherTick(tick);
  runDiffusionTick(tick);
  runAgentTicks(tick);
  recordOscillation(tick);
  runFireAndEnvironment(tick);
  runRaidsAndCombat(tick);
  runWorldEventsAndSuccession(tick);
  runStockpileExpansion();
  runGoalProgressAndSnapshot(tick);
}

/** Reserved for any recording that must run after the full tick (currently unused). */
function recordTickResults(_tick: number): void {}

async function runHeadlessStoryLlms(prompts: { system: string; user: string }[]): Promise<void> {
  const provider = (process.env['HEADLESS_LLM_PROVIDER'] ?? 'groq').toLowerCase();
  const groqKey = process.env['GROQ_API_KEY'];
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  const temperature = 0.88;
  for (let i = 0; i < prompts.length; i++) {
    const { system, user } = prompts[i]!;
    console.log(`\n--- HEADLESS STORY LLM ${i + 1}/${prompts.length} ---\n`);
    try {
      if (provider === 'anthropic') {
        if (!anthropicKey) {
          console.warn('ANTHROPIC_API_KEY missing; skip LLM call');
          continue;
        }
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5',
            max_tokens: 256,
            temperature,
            system,
            messages: [{ role: 'user', content: user }],
          }),
        });
        const data = (await res.json()) as { content?: Array<{ text?: string }> };
        console.log(data.content?.[0]?.text ?? JSON.stringify(data));
      } else {
        if (!groqKey) {
          console.warn('GROQ_API_KEY missing; skip LLM call');
          continue;
        }
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${groqKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'llama-3.1-8b-instant',
            max_tokens: 256,
            temperature,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
        });
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        console.log(data.choices?.[0]?.message?.content ?? JSON.stringify(data));
      }
    } catch (e) {
      console.warn('LLM call failed:', e);
    }
  }
}

// ── Tick loop ─────────────────────────────────────────────────────────────────
// Run TICKS simulation ticks; recording (actionCounts, logs, snapshots) happens inside runSimulationTick.

const t0 = Date.now();

for (let tick = 1; tick <= TICKS; tick++) {
  runSimulationTick(tick);
  recordTickResults(tick);
}

const elapsed = Date.now() - t0;

// ── Report helpers ────────────────────────────────────────────────────────────
// Each function prints one section of the final report (results table, deaths, goals, action frequencies, trait bias, oscillation). No game state changes.

function printResultsTable(
  ticks: number,
  elapsedMs: number,
  aliveCount: number,
  totalSpawned: number,
  deaths: number,
  raids: number,
  adventurerKills: number,
  goalsDone: number,
  last: TickSnapshot | undefined,
  fireLogLen: number,
  fireTilesTotal: number,
  fireTilesRainedOut: number,
  fireTilesMax: number,
): void {
  console.log(`\n${'─'.repeat(56)}`);
  console.log(` RESULTS  (${ticks} ticks in ${elapsedMs}ms — ${(ticks / (elapsedMs / 1000)).toFixed(0)} ticks/sec)`);
  console.log(`${'─'.repeat(56)}`);
  console.log(` Survivors:   ${aliveCount} / ${totalSpawned} total spawned`);
  console.log(` Deaths:      ${deaths}`);
  console.log(` Raids:       ${raids} (${adventurerKills} adventurers killed)`);
  console.log(` Goals done:  ${goalsDone}`);
  console.log(` Food stored: ${last?.totalFood.toFixed(0) ?? 0}`);
  console.log(` Ore stored:  ${last?.totalOre.toFixed(0) ?? 0}`);
  console.log(` Wood stored: ${last?.totalWood.toFixed(0) ?? 0}`);
  console.log(` Avg hunger:  ${last?.avgHunger.toFixed(1) ?? '?'}`);
  console.log(` Avg morale:  ${last?.avgMorale.toFixed(1) ?? '?'}`);
  console.log(` Avg fatigue: ${last?.avgFatigue.toFixed(1) ?? '?'}`);
  console.log(` Fire events: ${fireLogLen} ignitions · ${fireTilesTotal} tiles burned · ${fireTilesRainedOut} rained out · peak ${fireTilesMax} simultaneous`);
}

function printWarnings(log: { tick: number; name: string; message: string }[]): void {
  if (log.length === 0) return;
  console.log(`\n Warnings:`);
  for (const w of log) {
    console.log(`   [${w.tick}] ${w.name}: ${w.message}`);
  }
}

function printFireEvents(log: { tick: number; level: 'info' | 'warn' | 'error'; message: string }[]): void {
  if (log.length === 0) return;
  console.log(`\n Fire events:`);
  for (const e of log) {
    console.log(`   [${e.tick}] ${e.level.toUpperCase()} ${e.message}`);
  }
}

function printDeaths(log: { tick: number; name: string; cause: string }[]): void {
  if (log.length === 0) return;
  console.log(`\n Deaths:`);
  for (const d of log) {
    console.log(`   [${d.tick}] ${d.name} — ${d.cause}`);
  }
}

function printGoalsCompleted(log: { tick: number; type: string; generation: number }[]): void {
  if (log.length === 0) return;
  console.log(`\n Goals completed:`);
  for (const g of log) {
    console.log(`   [${g.tick}] ${g.type} (gen ${g.generation})`);
  }
}

/** Print top TOP_ACTIONS_COUNT actions with bar chart and percentage of total goblin-ticks. */
function printActionFrequencies(counts: Record<string, number>): void {
  console.log(`\n Action frequencies (top ${TOP_ACTIONS_COUNT}):`);
  const total = sumActionCounts(counts);
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, TOP_ACTIONS_COUNT);
  const maxCount = sorted[0]?.[1] ?? 1;
  for (const [action, count] of sorted) {
    const bar = '█'.repeat(Math.round((count / maxCount) * BAR_WIDTH));
    const pct = total ? ((count / total) * 100).toFixed(1) : '0';
    console.log(`   ${action.padEnd(24)} ${bar.padEnd(BAR_WIDTH)} ${pct}%`);
  }
}

/** Print per-trait action share (rest/fight/flee) and sanity checks for brave vs paranoid, lazy rest. */
function printTraitBias(
  byTrait: Record<string, Record<string, number>>,
  counts: Record<string, number>,
): void {
  const traitsPresent = Object.keys(byTrait);
  if (traitsPresent.length === 0) return;
  const totalTicks = sumActionCounts(counts);
  const colonyRestTicks = sumActionCounts(counts, k => k.startsWith('resting'));
  const colonyRestPct = totalTicks ? (colonyRestTicks / totalTicks) * 100 : 0;
  const colonyFightTicks = sumActionCounts(counts, k => k.startsWith('fighting'));
  const colonyFleeTicks = counts['fleeing to safety'] ?? 0;
  const colonyCombatTicks = colonyFightTicks + colonyFleeTicks;
  const restKeys = Object.entries(counts).filter(([k]) => k.startsWith('resting'));

  console.log(`\n Trait bias check (action share by personality):`);
  console.log(`   Colony totals: rest ${colonyRestTicks} ticks, fight ${colonyFightTicks}, flee ${colonyFleeTicks}${restKeys.length ? ` (rest keys: ${restKeys.map(([k, v]) => `${k}=${v}`).join(', ')})` : ' (no rest keys in action list)'}`);
  let braveFightRatio: number | null = null;
  let paranoidFightRatio: number | null = null;
  let lazyRestPct: number | null = null;

  for (const trait of traitsPresent.sort()) {
    const traitCounts = byTrait[trait];
    const traitTotal = Object.values(traitCounts).reduce((a, b) => a + b, 0);
    if (traitTotal < MIN_TRAIT_TICKS) continue;
    const rest = Object.entries(traitCounts).reduce((s, [k, v]) => (k.startsWith('resting') ? s + v : s), 0);
    const fight = Object.entries(traitCounts).reduce((s, [k, v]) => (k.startsWith('fighting') ? s + v : s), 0);
    const flee = traitCounts['fleeing to safety'] ?? 0;
    const combatTotal = fight + flee;
    const restPct = traitTotal ? (rest / traitTotal) * 100 : 0;
    const fightRatio = combatTotal > 10 ? fight / combatTotal : null;

    if (trait === 'brave' && fightRatio !== null) braveFightRatio = fightRatio;
    if (trait === 'paranoid' && fightRatio !== null) paranoidFightRatio = fightRatio;
    if (trait === 'lazy') lazyRestPct = restPct;

    const restVsColony = colonyRestPct > 0 ? (restPct / colonyRestPct).toFixed(2) : '—';
    const combatNote = combatTotal > 10 ? ` fight/(fight+flee)=${(fightRatio! * 100).toFixed(0)}%` : '';
    console.log(`   ${trait.padEnd(12)} rest ${restPct.toFixed(1)}% (${rest}/${traitTotal} ticks, vs colony ${restVsColony}x)${combatNote}`);
  }

  const checks: string[] = [];
  if (braveFightRatio !== null && paranoidFightRatio !== null && braveFightRatio >= paranoidFightRatio) {
    checks.push('brave fight ratio ≥ paranoid');
  } else if (braveFightRatio !== null && paranoidFightRatio !== null) {
    checks.push('brave fight ratio < paranoid (unexpected)');
  }
  if (lazyRestPct !== null && colonyRestPct > 0 && lazyRestPct >= colonyRestPct * 0.9) {
    checks.push('lazy rest share ≥ colony avg');
  } else if (lazyRestPct !== null && colonyRestPct > 0) {
    checks.push('lazy rest share below colony avg');
  }
  if (checks.length > 0) {
    console.log(`   → ${checks.join('; ')}`);
  }
  if (colonyRestTicks === 0 || colonyCombatTicks === 0) {
    console.log(`   Tip: ${colonyRestTicks === 0 ? 'Rest action rarely wins in headless (fatigue stays low). ' : ''}${colonyCombatTicks === 0 ? 'No fight/flee ticks (raids or danger not in range). ' : ''}Trait bias applies when those actions occur.`);
  }
}

/** Group oscillation log by goblin name, dedupe to first occurrence per goblin, print one line per oscillator. */
function printOscillation(
  log: Array<{ tick: number; name: string; trait: string; task: string; positions: string[]; tasks: string[] }>,
): void {
  const groups = new Map<string, number>();
  for (const e of log) {
    groups.set(e.name, (groups.get(e.name) ?? 0) + 1);
  }
  if (groups.size === 0) {
    console.log('\n✓ No oscillation detected.');
    return;
  }
  console.log('\n=== OSCILLATION LOG ===');
  const seen = new Map<string, typeof log[0]>();
  for (const e of log) {
    if (!seen.has(e.name)) seen.set(e.name, e);
  }
  for (const [name, count] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
    const first = seen.get(name)!;
    const taskStr = first.tasks.length > 1 ? `tasks=[${first.tasks.join(' ↔ ')}]` : `task="${first.task}"`;
    console.log(
      `  ${name} (${first.trait}): oscillated ${count} ticks | ${taskStr} | tiles=[${first.positions.join(', ')}]`
    );
  }
}

function printHeadlessReport(): void {
  const alive = goblins.filter(g => g.alive);
  const last = snapshots[snapshots.length - 1];

  printResultsTable(
    TICKS,
    elapsed,
    alive.length,
    goblins.length,
    deathLog.length,
    raidLog.length,
    adventurerKills,
    goalLog.length,
    last,
    fireLog.length,
    fireTilesTotal,
    fireTilesRainedOut,
    fireTilesMax,
  );
  printWarnings(warnLog);
  printFireEvents(fireLog);
  printDeaths(deathLog);
  printGoalsCompleted(goalLog);
  printActionFrequencies(actionCounts);
  printTraitBias(actionCountsByTrait, actionCounts);
  printOscillation(oscillationLog);
}

// ── Report ────────────────────────────────────────────────────────────────────
// Print all sections from the recording buffers; optionally write full JSON when DUMP_JSON=1.
printHeadlessReport();

if (DUMP_JSON) {
  const outPath = `headless-${seed}-${TICKS}.json`;
  const fs = await import('node:fs/promises');
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        seed,
        ticks: TICKS,
        snapshots,
        deathLog,
        raidLog,
        goalLog,
        actionCounts,
        actionCountsByTrait,
        warnLog,
        fireLog,
        fireTilesMax,
        fireTilesTotal,
        fireTilesRainedOut,
        oscillationLog,
      },
      null,
      2,
    ),
  );
  console.log(`\n JSON dumped → ${outPath}`);
}

if (headlessStoryLlm && storyLlmPrompts.length > 0) {
  await runHeadlessStoryLlms(storyLlmPrompts);
}

console.log();
