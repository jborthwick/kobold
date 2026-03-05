/**
 * Headless simulation harness — runs the full Kobold sim without Phaser/React.
 *
 * Usage:
 *   npx tsx scripts/headless.ts [ticks] [seed]
 *
 * Examples:
 *   npx tsx scripts/headless.ts              # 2000 ticks, random seed
 *   npx tsx scripts/headless.ts 5000         # 5000 ticks
 *   npx tsx scripts/headless.ts 2000 42      # reproducible run with seed 42
 *
 * Output: summary table + optional JSON dump (set DUMP_JSON=1 for full per-tick data)
 *   DUMP_JSON=1 npx tsx scripts/headless.ts 1000
 */

import { generateWorld, growback } from '../src/simulation/world';
import { tickFire, tickBurningGoblins } from '../src/simulation/fire';
import { tickLightning } from '../src/simulation/lightning';
import { tickPooling } from '../src/simulation/pooling';
import { spawnGoblins, spawnSuccessor, SUCCESSION_DELAY, fortEnclosureSlots } from '../src/simulation/agents';
import { tickAgentUtility } from '../src/simulation/utilityAI';
import { maybeSpawnRaid, tickAdventurers, resetAdventurers, spawnInitialAdventurers } from '../src/simulation/adventurers';
import { createWarmthField, createDangerField, computeWarmth, computeDanger, updateTraffic, findHearths } from '../src/simulation/diffusion';
import { createWeather, tickWeather, growbackModifier, metabolismModifier } from '../src/simulation/weather';
import { tickWorldEvents, getNextEventTick, setNextEventTick, tickMushroomSprout } from '../src/simulation/events';
import { rollWound } from '../src/simulation/wounds';
import { getActiveFaction } from '../src/shared/factions';
import { GRID_SIZE } from '../src/shared/constants';
import type { Goblin, Tile, FoodStockpile, OreStockpile, WoodStockpile, ColonyGoal, Adventurer } from '../src/shared/types';
import { TileType } from '../src/shared/types';
import { FORAGEABLE_TILES } from '../src/simulation/agents/sites';

// ── CLI args ──────────────────────────────────────────────────────────────────

const TICKS      = parseInt(process.argv[2] ?? '2000', 10);
const SEED_ARG   = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;
const DUMP_JSON  = process.env['DUMP_JSON'] === '1';

// ── Stats ─────────────────────────────────────────────────────────────────────

interface TickSnapshot {
  tick:        number;
  alive:       number;
  totalFood:   number;
  totalOre:    number;
  totalWood:   number;
  avgHunger:   number;
  avgMorale:   number;
  avgFatigue:  number;
  raiders:     number;
}

const snapshots:     TickSnapshot[] = [];
const actionCounts:  Record<string, number> = {};
const deathLog:      { tick: number; name: string; cause: string }[] = [];
const raidLog:       { tick: number; count: number }[] = [];
const goalLog:       { tick: number; type: string; generation: number }[] = [];
const warnLog:       { tick: number; name: string; message: string }[] = [];
const fireLog:       { tick: number; message: string }[] = [];
let   fireTilesMax   = 0;  // peak simultaneous fire tile count
let   fireTilesTotal     = 0;  // cumulative tiles that burned or were extinguished
let   fireTilesRainedOut = 0;  // tiles extinguished by rain

function recordAction(task: string) {
  // Normalise task string to a bare action label.
  // Tasks starting with → are navigation steps (traveling), not idle.
  const key = task.startsWith('→')
    ? 'traveling'
    : task.replace(/\s*[\(→].*/, '').trim() || 'idle';
  actionCounts[key] = (actionCounts[key] ?? 0) + 1;
}

// ── Stockpile expansion (replicated from WorldScene.findNextStockpileSlot) ────

function findNextStockpileSlot(
  existing:    Array<{ x: number; y: number }>,
  allOccupied: Array<{ x: number; y: number }>,
  grid:        Tile[][],
  otherGroup?: Array<{ x: number; y: number }>,
): { x: number; y: number } | null {
  const anchor      = existing[0];
  const occupiedSet = new Set(allOccupied.map(p => `${p.x},${p.y}`));
  const expandDir   = (!otherGroup || otherGroup.length === 0)
    ? -1
    : (otherGroup[0].x > anchor.x ? -1 : 1);
  const colOffsets  = [0, expandDir * 1, expandDir * 2];
  const isValid     = (x: number, y: number) =>
    x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE
    && !occupiedSet.has(`${x},${y}`)
    && grid[y][x].type !== TileType.Water
    && grid[y][x].type !== TileType.Wall;
  const rows = [...new Set(existing.map(p => p.y))].sort((a, b) => a - b);
  for (const row of rows) {
    for (const off of colOffsets) {
      if (isValid(anchor.x + off, row)) return { x: anchor.x + off, y: row };
    }
  }
  const nextRow = (rows[rows.length - 1] ?? anchor.y) + 1;
  for (const off of colOffsets) {
    if (isValid(anchor.x + off, nextRow)) return { x: anchor.x + off, y: nextRow };
  }
  return null;
}

// ── Goal helpers (replicated from WorldScene) ─────────────────────────────────

type GoalType = ColonyGoal['type'];
const GOAL_CYCLE: GoalType[] = ['stockpile_food', 'survive_ticks', 'defeat_adventurers', 'enclose_fort'];

function makeGoal(type: GoalType, generation: number): ColonyGoal {
  const scale = 1 + generation * 0.6;
  const desc  = getActiveFaction().goalDescriptions;
  switch (type) {
    case 'stockpile_food':     return { type, description: desc.stockpile_food(Math.round(80 * scale)),      progress: 0, target: Math.round(80 * scale),  generation };
    case 'survive_ticks':      return { type, description: desc.survive_ticks(Math.round(800 * scale)),      progress: 0, target: Math.round(800 * scale), generation };
    case 'defeat_adventurers': return { type, description: desc.defeat_adventurers(Math.round(5 * scale)),   progress: 0, target: Math.round(5 * scale),   generation };
    case 'enclose_fort':       return { type, description: desc.enclose_fort(),                               progress: 0, target: 1,                        generation };
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

console.log(`\n🧌 Kobold headless sim — ${TICKS} ticks${SEED_ARG !== undefined ? `, seed ${SEED_ARG}` : ''}\n`);

const { grid, spawnZone, seed } = generateWorld(SEED_ARG?.toString());
console.log(`   World seed: ${seed}`);

// World stats for diagnostics
let totalForageable = 0;
let forageableNearSpawn = 0;
const spawnCx = spawnZone.x + Math.floor(spawnZone.w / 2);
const spawnCy = spawnZone.y + Math.floor(spawnZone.h / 2);
for (let y = 0; y < GRID_SIZE; y++) {
  for (let x = 0; x < GRID_SIZE; x++) {
    if (FORAGEABLE_TILES.has(grid[y][x].type)) {
      totalForageable++;
      const dist = Math.sqrt((x - spawnCx) ** 2 + (y - spawnCy) ** 2);
      if (dist < 30) forageableNearSpawn++;
    }
  }
}
console.log(`   Harvestable: ${forageableNearSpawn} tiles within 30 of spawn`);
console.log(`   Total: ${totalForageable} ${[...FORAGEABLE_TILES].join('/')} tiles across ${GRID_SIZE}x${GRID_SIZE} map`);

let goblins:       Goblin[]       = spawnGoblins(grid, spawnZone);
let adventurers:   Adventurer[]   = spawnInitialAdventurers(grid, 3);
resetAdventurers();

const depotX = Math.floor(spawnZone.x + spawnZone.w / 2);
const depotY = Math.floor(spawnZone.y + spawnZone.h / 2);

let foodStockpiles: FoodStockpile[] = [{ x: depotX,     y: depotY, food: 0,   maxFood: 200 }];
let oreStockpiles:  OreStockpile[]  = [{ x: depotX + 8, y: depotY, ore:  150, maxOre:  200 }];
let woodStockpiles: WoodStockpile[] = [{ x: depotX - 8, y: depotY, wood: 0,   maxWood: 200 }];

for (const g of goblins) g.homeTile = { x: depotX, y: depotY };

let colonyGoal         = makeGoal('stockpile_food', 0);
let goalStartTick      = 0;
let adventurerKills    = 0;
const pendingSuccessions: { deadGoblinId: string; spawnAtTick: number }[] = [];
const combatHits       = new Map<string, number>();

const weather     = createWeather(0);
const warmthField = createWarmthField();
const dangerField = createDangerField();
const dangerPrev  = createDangerField();

setNextEventTick(300 + Math.floor(Math.random() * 300));

// ── Tick loop ─────────────────────────────────────────────────────────────────

const t0 = Date.now();

for (let tick = 1; tick <= TICKS; tick++) {

  // Weather
  tickWeather(weather, tick);

  // Diffusion
  const hearths = findHearths(grid);
  computeWarmth(grid, hearths, foodStockpiles, weather.type, warmthField);
  computeDanger(grid, adventurers, dangerPrev, dangerField);
  dangerPrev.set(dangerField);
  updateTraffic(grid, goblins);
  for (const g of goblins) {
    if (g.alive) {
      const raw = warmthField[g.y * GRID_SIZE + g.x];
      g.warmth = (g.warmth ?? raw) * 0.95 + raw * 0.05;
    }
  }

  // Agent ticks
  for (const g of goblins) {
    const wasAlive = g.alive;
    tickAgentUtility(
      g, grid, tick, goblins,
      (message, level) => {
        if (level === 'warn' || level === 'error') {
          warnLog.push({ tick, name: g.name, message });
        }
      },
      foodStockpiles, adventurers, oreStockpiles, colonyGoal, woodStockpiles,
      metabolismModifier(weather), warmthField, dangerField, weather.type,
    );
    if (g.alive) recordAction(g.task);
    if (wasAlive && !g.alive) {
      deathLog.push({ tick, name: g.name, cause: g.causeOfDeath ?? 'unknown' });
      pendingSuccessions.push({ deadGoblinId: g.id, spawnAtTick: tick + SUCCESSION_DELAY });
    }
  }

  // Burning goblins + Growback + Pooling + Fire
  tickBurningGoblins(grid, tick, goblins, (msg, level) => {
    if (level === 'warn' || level === 'error') fireLog.push({ tick, message: msg });
  });
  growback(grid, growbackModifier(weather), tick);
  tickPooling(grid, tick, weather.type);
  tickLightning(grid, tick, weather.type, (msg, level) => {
    if (level === 'warn' || level === 'error') fireLog.push({ tick, message: msg });
  });
  const fireResult = tickFire(grid, tick, goblins, weather.type, (msg, level) => {
    if (level === 'warn' || level === 'error') fireLog.push({ tick, message: msg });
  });
  fireTilesTotal     += fireResult.burnouts;
  fireTilesRainedOut += fireResult.extinguished;

  // Track peak fire tile count
  let fireTileCount = 0;
  for (let fy = 0; fy < GRID_SIZE; fy++)
    for (let fx = 0; fx < GRID_SIZE; fx++)
      if (grid[fy][fx].type === TileType.Fire) fireTileCount++;
  if (fireTileCount > fireTilesMax) fireTilesMax = fireTileCount;

  // Raids
  const raid = maybeSpawnRaid(grid, goblins, tick);
  if (raid) {
    adventurers.push(...raid.adventurers);
    raidLog.push({ tick, count: raid.count });
  }

  if (adventurers.length > 0) {
    const gr = tickAdventurers(adventurers, goblins, grid, tick);
    for (const { goblinId, damage } of gr.attacks) {
      const g = goblins.find(d => d.id === goblinId);
      if (g && g.alive) {
        g.health = Math.max(0, g.health - damage);
        g.morale = Math.max(0, g.morale - 5);
        if (g.health <= 0) {
          g.alive        = false;
          g.task         = 'dead';
          g.causeOfDeath = 'killed by adventurers';
          deathLog.push({ tick, name: g.name, cause: g.causeOfDeath });
          pendingSuccessions.push({ deadGoblinId: g.id, spawnAtTick: tick + SUCCESSION_DELAY });
        } else {
          const hits = (combatHits.get(g.id) ?? 0) + 1;
          combatHits.set(g.id, hits);
          const w = rollWound(g, tick);
          if (w) g.wound = w;
        }
      }
    }
    adventurerKills += gr.adventurerDeaths.length;
    const deadIds = new Set(gr.adventurerDeaths);
    adventurers = adventurers.filter(a => !deadIds.has(a.id));
    combatHits.forEach((_, id) => { if (deadIds.has(id)) combatHits.delete(id); });
  }

  // World events
  tickWorldEvents(grid, tick, goblins, adventurers);
  tickMushroomSprout(grid, tick);

  // Succession
  for (let i = pendingSuccessions.length - 1; i >= 0; i--) {
    const s = pendingSuccessions[i];
    if (tick < s.spawnAtTick) continue;
    pendingSuccessions.splice(i, 1);
    const dead = goblins.find(g => g.id === s.deadGoblinId);
    if (!dead) continue;
    const successor = spawnSuccessor(dead, grid, spawnZone, goblins, tick);
    successor.homeTile = { x: foodStockpiles[0].x, y: foodStockpiles[0].y };
    goblins.push(successor);
    successor.llmReasoning = `I heard what happened to ${dead.name}. I will not make the same mistakes.`;
    successor.memory.push({ tick, crisis: 'arrival', action: `arrived to replace ${dead.name}` });
  }

  // Stockpile expansion
  const lastFood = foodStockpiles[foodStockpiles.length - 1];
  if (lastFood.food >= lastFood.maxFood) {
    const all = [...foodStockpiles, ...oreStockpiles, ...woodStockpiles];
    const pos = findNextStockpileSlot(foodStockpiles, all, grid, oreStockpiles);
    if (pos) foodStockpiles.push({ ...pos, food: 0, maxFood: 200 });
  }
  const lastOre = oreStockpiles[oreStockpiles.length - 1];
  if (lastOre.ore >= lastOre.maxOre) {
    const all = [...foodStockpiles, ...oreStockpiles, ...woodStockpiles];
    const pos = findNextStockpileSlot(oreStockpiles, all, grid, foodStockpiles);
    if (pos) oreStockpiles.push({ ...pos, ore: 0, maxOre: 200 });
  }
  const lastWood = woodStockpiles[woodStockpiles.length - 1];
  if (lastWood && lastWood.wood >= lastWood.maxWood) {
    const all = [...foodStockpiles, ...oreStockpiles, ...woodStockpiles];
    const pos = findNextStockpileSlot(woodStockpiles, all, grid);
    if (pos) woodStockpiles.push({ ...pos, wood: 0, maxWood: 200 });
  }

  // Goal progress
  const alive = goblins.filter(g => g.alive);
  switch (colonyGoal.type) {
    case 'stockpile_food':     colonyGoal.progress = foodStockpiles.reduce((s, d) => s + d.food, 0); break;
    case 'survive_ticks':      colonyGoal.progress = tick - goalStartTick; break;
    case 'defeat_adventurers': colonyGoal.progress = adventurerKills; break;
    case 'enclose_fort': {
      const rem = fortEnclosureSlots(foodStockpiles, oreStockpiles, grid, goblins, '', adventurers);
      colonyGoal.progress = rem.length === 0 ? 1 : 0;
      break;
    }
  }
  if (colonyGoal.progress >= colonyGoal.target) {
    for (const g of alive) g.morale = Math.min(100, g.morale + 15);
    goalLog.push({ tick, type: colonyGoal.type, generation: colonyGoal.generation });
    const curr = GOAL_CYCLE.indexOf(colonyGoal.type);
    const next = GOAL_CYCLE[(curr + 1) % GOAL_CYCLE.length];
    if (next === 'defeat_adventurers') adventurerKills = 0;
    goalStartTick = tick;
    colonyGoal = makeGoal(next, colonyGoal.generation + 1);
  }

  // Snapshot every 10 ticks
  if (tick % 10 === 0) {
    const aliveNow = goblins.filter(g => g.alive);
    snapshots.push({
      tick,
      alive:      aliveNow.length,
      totalFood:  foodStockpiles.reduce((s, d) => s + d.food, 0),
      totalOre:   oreStockpiles.reduce((s, d) => s + d.ore, 0),
      totalWood:  woodStockpiles.reduce((s, d) => s + d.wood, 0),
      avgHunger:  aliveNow.length ? aliveNow.reduce((s, g) => s + g.hunger, 0) / aliveNow.length : 0,
      avgMorale:  aliveNow.length ? aliveNow.reduce((s, g) => s + g.morale, 0) / aliveNow.length : 0,
      avgFatigue: aliveNow.length ? aliveNow.reduce((s, g) => s + g.fatigue, 0) / aliveNow.length : 0,
      raiders:    adventurers.length,
    });
  }
}

const elapsed = Date.now() - t0;

// ── Report ────────────────────────────────────────────────────────────────────

const alive = goblins.filter(g => g.alive);
const last  = snapshots[snapshots.length - 1];

console.log(`\n${'─'.repeat(56)}`);
console.log(` RESULTS  (${TICKS} ticks in ${elapsed}ms — ${(TICKS / (elapsed / 1000)).toFixed(0)} ticks/sec)`);
console.log(`${'─'.repeat(56)}`);
console.log(` Survivors:   ${alive.length} / ${goblins.length} total spawned`);
console.log(` Deaths:      ${deathLog.length}`);
console.log(` Raids:       ${raidLog.length} (${adventurerKills} adventurers killed)`);
console.log(` Goals done:  ${goalLog.length}`);
console.log(` Food stored: ${last?.totalFood.toFixed(0) ?? 0}`);
console.log(` Ore stored:  ${last?.totalOre.toFixed(0) ?? 0}`);
console.log(` Wood stored: ${last?.totalWood.toFixed(0) ?? 0}`);
console.log(` Avg hunger:  ${last?.avgHunger.toFixed(1) ?? '?'}`);
console.log(` Avg morale:  ${last?.avgMorale.toFixed(1) ?? '?'}`);
console.log(` Avg fatigue: ${last?.avgFatigue.toFixed(1) ?? '?'}`);
console.log(` Fire events: ${fireLog.length} ignitions · ${fireTilesTotal} tiles burned · ${fireTilesRainedOut} rained out · peak ${fireTilesMax} simultaneous`);

if (fireLog.length > 0) {
  console.log(`\n Fire events:`);
  for (const f of fireLog) {
    console.log(`   [${f.tick}] ${f.message}`);
  }
}

if (deathLog.length > 0) {
  console.log(`\n Deaths:`);
  for (const d of deathLog) {
    console.log(`   [${d.tick}] ${d.name} — ${d.cause}`);
  }
}

if (goalLog.length > 0) {
  console.log(`\n Goals completed:`);
  for (const g of goalLog) {
    console.log(`   [${g.tick}] ${g.type} (gen ${g.generation})`);
  }
}

// Action frequency table — top 15
console.log(`\n Action frequencies (top 15):`);
const sorted = Object.entries(actionCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
const maxCount = sorted[0]?.[1] ?? 1;
for (const [action, count] of sorted) {
  const bar  = '█'.repeat(Math.round((count / maxCount) * 20));
  const pct  = ((count / Object.values(actionCounts).reduce((a, b) => a + b, 0)) * 100).toFixed(1);
  console.log(`   ${action.padEnd(24)} ${bar.padEnd(20)} ${pct}%`);
}

if (DUMP_JSON) {
  const outPath = `headless-${seed}-${TICKS}.json`;
  const fs = await import('node:fs/promises');
  await fs.writeFile(outPath, JSON.stringify({ seed, ticks: TICKS, snapshots, deathLog, raidLog, goalLog, actionCounts, warnLog, fireLog, fireTilesMax, fireTilesTotal }, null, 2));
  console.log(`\n JSON dumped → ${outPath}`);
}

console.log();
