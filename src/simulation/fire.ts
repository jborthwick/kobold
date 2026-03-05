/**
 * Fire system — ignition, spread, burnout, and goblin damage.
 *
 * Fires spread in slow waves: high probability but long intervals between attempts.
 * Rain extinguishes active fires tile-by-tile each tick.
 * Burnout converts fire tiles to Dirt.
 *
 * Spread model: each fire tile attempts to spread every SPREAD_INTERVAL ticks,
 * staggered by its own fireTick so cascades don't all fire simultaneously.
 * During rain, spreading is blocked and each tile has a chance to be extinguished.
 */

import { TileType, type Tile, type Goblin, type WeatherType } from '../shared/types';
import { GRID_SIZE } from '../shared/constants';

const FLAMMABLE = new Set([TileType.Grass, TileType.Forest, TileType.Mushroom, TileType.Farmland, TileType.TreeStump]);

const FIRE_DURATION       = 90;    // ticks before natural burnout → Dirt
const SPREAD_INTERVAL     = 25;    // ticks between spread attempts per fire tile
const BASE_IGNITION       = 0.0003; // per hearth × per adjacent flammable tile/tick
const BASE_SPREAD         = 0.80;  // probability per neighbor per spread attempt
const RAIN_EXTINGUISH     = 0.25;  // probability per fire tile per tick during rain
const FIRE_DAMAGE_HP           = 5;     // hp lost per tick while standing on a fire tile
const FIRE_DAMAGE_MOR          = 3;     // morale lost per tick while standing on a fire tile
const FIRE_LOG_COOLDOWN        = 30;    // ticks between "on fire!" log messages per goblin
const GOBLIN_CATCH_FIRE_CHANCE = 0.15;  // chance to catch fire per tick while standing on a fire tile

// Burning goblin constants
const ON_FIRE_DAMAGE_HP        = 2;     // hp DoT per tick while burning
const ON_FIRE_DURATION         = 50;    // ticks before flames burn out naturally
const ON_FIRE_TERRAIN_CHANCE   = 0.04;  // burning goblin ignites the tile they're standing on
const FRIENDLY_EXTINGUISH      = 0.20;  // per-tick chance adjacent goblin smothers the flames

const EXTINGUISH_TILES = new Set([TileType.Water, TileType.Pool]);

type LogFn = (message: string, level: 'info' | 'warn' | 'error') => void;

interface WeatherMod {
  ignition:    number;  // multiplier on BASE_IGNITION
  spread:      number;  // multiplier on BASE_SPREAD (0 = no spreading)
  extinguish:  number;  // per-tile per-tick extinguish chance (0 = no rain suppression)
}

function weatherMod(weatherType: WeatherType | undefined): WeatherMod {
  switch (weatherType) {
    case 'drought': return { ignition: 3,   spread: 1.2, extinguish: 0 };
    case 'rain':    return { ignition: 0,   spread: 0,   extinguish: RAIN_EXTINGUISH };
    case 'cold':    return { ignition: 0.5, spread: 0.6, extinguish: 0 };
    default:        return { ignition: 1,   spread: 1,   extinguish: 0 };
  }
}

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;

export function tickFire(
  grid: Tile[][],
  currentTick: number,
  goblins: Goblin[],
  weatherType?: WeatherType,
  onLog?: LogFn,
): { burnouts: number; extinguished: number } {
  const mod = weatherMod(weatherType);
  const newFires:     { x: number; y: number }[] = [];
  const burnouts:     { x: number; y: number }[] = [];
  const extinguished: { x: number; y: number }[] = [];
  let loggedIgnition = false;

  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const t = grid[y][x];

      if (t.type === TileType.Hearth) {
        if (mod.ignition === 0) continue;
        for (const [dx, dy] of DIRS) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
          const n = grid[ny][nx];
          if (FLAMMABLE.has(n.type) && Math.random() < BASE_IGNITION * mod.ignition) {
            newFires.push({ x: nx, y: ny });
            if (!loggedIgnition) {
              onLog?.(`🔥 A hearth has set ${n.type} ablaze!`, 'warn');
              loggedIgnition = true;
            }
          }
        }
      } else if (t.type === TileType.Fire) {
        const age = currentTick - (t.fireTick ?? currentTick);

        // Rain extinguishes before checking burnout or spread
        if (mod.extinguish > 0 && Math.random() < mod.extinguish) {
          extinguished.push({ x, y });
          continue;
        }

        if (age >= FIRE_DURATION) {
          burnouts.push({ x, y });
        } else if (mod.spread > 0 && age % SPREAD_INTERVAL === 0 && age > 0) {
          // High-probability slow wave: attempt spread every SPREAD_INTERVAL ticks,
          // staggered per-tile so all fires don't pulse at the same moment.
          const p = Math.min(0.95, BASE_SPREAD * mod.spread);
          for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
            const n = grid[ny][nx];
            if (FLAMMABLE.has(n.type) && Math.random() < p) {
              newFires.push({ x: nx, y: ny });
            }
          }
        }
      }
    }
  }

  // Apply rain extinguishments → Dirt
  for (const { x, y } of extinguished) {
    const t = grid[y][x];
    grid[y][x] = { type: TileType.Dirt, foodValue: 0, maxFood: 0, materialValue: 0, maxMaterial: 0, growbackRate: 0, trafficScore: t.trafficScore };
  }

  // Apply new fires (skip tiles already burning)
  for (const { x, y } of newFires) {
    const t = grid[y][x];
    if (t.type === TileType.Fire) continue;
    grid[y][x] = { ...t, type: TileType.Fire, foodValue: 0, maxFood: 0, materialValue: 0, maxMaterial: 0, growbackRate: 0, fireTick: currentTick };
  }

  // Apply natural burnouts → Dirt
  for (const { x, y } of burnouts) {
    const t = grid[y][x];
    grid[y][x] = { type: TileType.Dirt, foodValue: 0, maxFood: 0, materialValue: 0, maxMaterial: 0, growbackRate: 0, trafficScore: t.trafficScore };
  }

  // Goblin standing on fire tile: direct damage + chance to catch fire
  for (const g of goblins) {
    if (!g.alive) continue;
    const tile = grid[g.y]?.[g.x];
    if (tile?.type !== TileType.Fire) continue;

    g.health -= FIRE_DAMAGE_HP;
    g.morale  = Math.max(0, g.morale - FIRE_DAMAGE_MOR);

    if (g.health <= 0) {
      g.alive        = false;
      g.health       = 0;
      g.task         = 'dead';
      g.causeOfDeath = 'burned alive';
      onLog?.(`💀 ${g.name} burned alive!`, 'error');
    } else if (!g.onFire && Math.random() < GOBLIN_CATCH_FIRE_CHANCE) {
      g.onFire     = true;
      g.onFireTick = currentTick;
      onLog?.(`🔥 ${g.name} caught fire!`, 'warn');
    }
  }

  return { burnouts: burnouts.length + extinguished.length, extinguished: extinguished.length };
}

/**
 * Tick burning goblins — DoT, terrain spread, friendly extinguish, water extinguish.
 * Call this AFTER tickAgentUtility (so flee-to-water movement has already happened)
 * and BEFORE tickFire (fire tile damage is separate from goblin-on-fire DoT).
 */
export function tickBurningGoblins(
  grid:        Tile[][],
  currentTick: number,
  goblins:     Goblin[],
  onLog?:      LogFn,
): void {
  for (const g of goblins) {
    if (!g.alive || !g.onFire) continue;

    // DoT damage
    g.health -= ON_FIRE_DAMAGE_HP;
    g.morale  = Math.max(0, g.morale - 1);

    if (g.health <= 0) {
      g.alive        = false;
      g.health       = 0;
      g.task         = 'dead';
      g.causeOfDeath = 'burned alive';
      g.onFire       = false;
      onLog?.(`💀 ${g.name} burned to a crisp!`, 'error');
      continue;
    }

    // Natural burnout after duration
    const age = currentTick - (g.onFireTick ?? currentTick);
    if (age >= ON_FIRE_DURATION) {
      g.onFire = false;
      onLog?.(`${g.name}'s flames finally went out.`, 'info');
      continue;
    }

    // Extinguish if standing on water or a rain pool
    const tile = grid[g.y]?.[g.x];
    if (tile && EXTINGUISH_TILES.has(tile.type)) {
      g.onFire = false;
      g.morale = Math.max(0, g.morale - 5);
      onLog?.(`💧 ${g.name} dove into the water and put themselves out!`, 'warn');
      continue;
    }

    // Spread fire to the tile the goblin is standing on
    if (tile && FLAMMABLE.has(tile.type) && Math.random() < ON_FIRE_TERRAIN_CHANCE) {
      grid[g.y][g.x] = {
        ...tile,
        type: TileType.Fire, foodValue: 0, maxFood: 0,
        materialValue: 0, maxMaterial: 0, growbackRate: 0,
        fireTick: currentTick,
      };
    }

    // Adjacent friendly goblins can smother the flames
    const helpers = goblins.filter(o =>
      o.alive && !o.onFire && o.id !== g.id &&
      Math.abs(o.x - g.x) <= 1 && Math.abs(o.y - g.y) <= 1,
    );
    if (helpers.length > 0 && Math.random() < FRIENDLY_EXTINGUISH) {
      const helper = helpers[Math.floor(Math.random() * helpers.length)];
      g.onFire = false;
      onLog?.(`🤝 ${helper.name} beat the flames off ${g.name}!`, 'warn');
    }
  }
}
