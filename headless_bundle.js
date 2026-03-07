// src/simulation/world.ts
import { createNoise2D } from "simplex-noise";

// src/shared/constants.ts
var GRID_SIZE = 128;
var INITIAL_GOBLINS = 5;
var MAX_INVENTORY_CAPACITY = 20;

// src/simulation/agents/sites.ts
var SITE_RECORD_THRESHOLD = 3;
var MAX_KNOWN_SITES = 5;
var PATCH_MERGE_RADIUS = 4;
function recordSite(sites, x, y, value, tick) {
  const idx2 = sites.findIndex((s) => s.x === x && s.y === y);
  if (idx2 >= 0) {
    sites[idx2] = { x, y, value, tick };
    return;
  }
  const nearIdx = sites.findIndex(
    (s) => Math.abs(s.x - x) + Math.abs(s.y - y) <= PATCH_MERGE_RADIUS
  );
  if (nearIdx >= 0) {
    if (value > sites[nearIdx].value) {
      sites[nearIdx] = { x, y, value, tick };
    } else {
      sites[nearIdx] = { ...sites[nearIdx], tick };
    }
    return;
  }
  if (sites.length < MAX_KNOWN_SITES) {
    sites.push({ x, y, value, tick });
    return;
  }
  const weakIdx = sites.reduce((min, s, i) => s.value < sites[min].value ? i : min, 0);
  if (value > sites[weakIdx].value) sites[weakIdx] = { x, y, value, tick };
}
var FORAGEABLE_TILES = /* @__PURE__ */ new Set([
  "mushroom" /* Mushroom */
]);

// src/simulation/world.ts
var WORLD_CONFIG = {
  forestFoodMin: 8,
  forestFoodMax: 12,
  forestGrowback: 0.04,
  forestWoodMin: 8,
  forestWoodMax: 12,
  farmFoodMin: 2,
  farmFoodMax: 3,
  farmGrowback: 0.02,
  oreMatMin: 30,
  oreMatMax: 50,
  oreGrowback: 0,
  grassMeadowFoodMin: 2,
  grassMeadowFoodMax: 4,
  grassMeadowGrowback: 0.02,
  mushroomFoodMin: 3,
  mushroomFoodMax: 5,
  mushroomGrowback: 0.08
};
function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i) | 0;
  }
  return h >>> 0;
}
function mulberry32(seed2) {
  let s = seed2 | 0;
  return () => {
    s = s + 1831565813 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function fbm(noise, x, y, octaves, frequency, persistence, lacunarity) {
  let value = 0;
  let amplitude = 1;
  let maxAmplitude = 0;
  let freq = frequency;
  for (let i = 0; i < octaves; i++) {
    value += noise(x * freq, y * freq) * amplitude;
    maxAmplitude += amplitude;
    amplitude *= persistence;
    freq *= lacunarity;
  }
  return value / maxAmplitude;
}
function norm01(v) {
  return Math.max(0, Math.min(1, (v + 1) / 2));
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function classifyBiome(elevation, moisture) {
  if (elevation < 0.22) return "water" /* Water */;
  if (elevation < 0.38) {
    if (moisture > 0.72) return "mushroom" /* Mushroom */;
    if (moisture > 0.52) return "farmland" /* Farmland */;
    if (moisture > 0.32) return "grass" /* Grass */;
    return "dirt" /* Dirt */;
  }
  if (elevation < 0.58) {
    if (moisture > 0.58) return "forest" /* Forest */;
    if (moisture > 0.3) return "grass" /* Grass */;
    return "dirt" /* Dirt */;
  }
  if (elevation < 0.78) {
    if (moisture > 0.68) return "forest" /* Forest */;
    if (moisture > 0.35) return "dirt" /* Dirt */;
    return "stone" /* Stone */;
  }
  if (moisture > 0.5) return "ore" /* Ore */;
  if (moisture > 0.35) return "stone" /* Stone */;
  return "ore" /* Ore */;
}
function tileResourceValues(type, elevation, moisture, rng) {
  switch (type) {
    case "forest" /* Forest */: {
      const foodScale = Math.max(0, (moisture - 0.58) / 0.42);
      const fMax = lerp(WORLD_CONFIG.forestFoodMin, WORLD_CONFIG.forestFoodMax, foodScale);
      const wMax = lerp(WORLD_CONFIG.forestWoodMin, WORLD_CONFIG.forestWoodMax, 0.5 + rng() * 0.5);
      return {
        foodValue: fMax * (0.7 + rng() * 0.3),
        materialValue: wMax * (0.7 + rng() * 0.3),
        maxFood: fMax,
        maxMaterial: wMax,
        growbackRate: WORLD_CONFIG.forestGrowback
      };
    }
    case "mushroom" /* Mushroom */: {
      const richness = Math.max(0, (moisture - 0.72) / 0.28);
      const fMax = lerp(WORLD_CONFIG.mushroomFoodMin, WORLD_CONFIG.mushroomFoodMax, richness);
      return {
        foodValue: fMax * (0.7 + rng() * 0.3),
        materialValue: 0,
        maxFood: fMax,
        maxMaterial: 0,
        growbackRate: WORLD_CONFIG.mushroomGrowback
      };
    }
    case "grass" /* Grass */: {
      const fMax = lerp(WORLD_CONFIG.grassMeadowFoodMin, WORLD_CONFIG.grassMeadowFoodMax, moisture);
      return {
        foodValue: fMax * (0.7 + rng() * 0.3),
        materialValue: 0,
        maxFood: fMax,
        maxMaterial: 0,
        growbackRate: WORLD_CONFIG.grassMeadowGrowback
      };
    }
    case "farmland" /* Farmland */: {
      const fMax = lerp(WORLD_CONFIG.farmFoodMin, WORLD_CONFIG.farmFoodMax, moisture);
      return {
        foodValue: fMax * (0.7 + rng() * 0.3),
        materialValue: 0,
        maxFood: fMax,
        maxMaterial: 0,
        growbackRate: WORLD_CONFIG.farmGrowback
      };
    }
    case "ore" /* Ore */: {
      const richness = elevation > 0.78 ? Math.max(0, (elevation - 0.78) / 0.22) : Math.max(0, (elevation - 0.58) / 0.2);
      const matMax = lerp(WORLD_CONFIG.oreMatMin, WORLD_CONFIG.oreMatMax, richness);
      return {
        foodValue: 0,
        materialValue: matMax * (0.7 + rng() * 0.3),
        maxFood: 0,
        maxMaterial: matMax,
        growbackRate: WORLD_CONFIG.oreGrowback
      };
    }
    default:
      return { foodValue: 0, materialValue: 0, maxFood: 0, maxMaterial: 0, growbackRate: 0 };
  }
}
function countNearbyFoodTiles(grid2, cx, cy, radius) {
  let count = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
      const t = grid2[y][x];
      if (FORAGEABLE_TILES.has(t.type) && t.maxFood > 0) count++;
    }
  }
  return count;
}
function seedMushroomPatch(grid2, cx, cy, rng) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
      const t = grid2[y][x];
      if (t.type === "water" /* Water */ || t.type === "wall" /* Wall */) continue;
      if (rng() > 0.6) continue;
      const fMax = lerp(WORLD_CONFIG.mushroomFoodMin, WORLD_CONFIG.mushroomFoodMax, rng());
      grid2[y][x] = {
        type: "mushroom" /* Mushroom */,
        foodValue: fMax,
        materialValue: 0,
        maxFood: fMax,
        maxMaterial: 0,
        growbackRate: WORLD_CONFIG.mushroomGrowback
      };
    }
  }
}
var NOISE_PARAMS = {
  elevation: { frequency: 0.04, octaves: 3, persistence: 0.5, lacunarity: 2 },
  moisture: { frequency: 0.035, octaves: 3, persistence: 0.5, lacunarity: 2 }
};
function generateWorld(seed2) {
  const worldSeed = seed2 ?? Date.now().toString();
  const rng = mulberry32(hashSeed(worldSeed));
  const elevNoise = createNoise2D(mulberry32(hashSeed(worldSeed + "_elev")));
  const moistNoise = createNoise2D(mulberry32(hashSeed(worldSeed + "_moist")));
  const spotNoise = createNoise2D(mulberry32(hashSeed(worldSeed + "_spot")));
  const grid2 = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    grid2[y] = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      const elev = norm01(fbm(elevNoise, x, y, NOISE_PARAMS.elevation.octaves, NOISE_PARAMS.elevation.frequency, NOISE_PARAMS.elevation.persistence, NOISE_PARAMS.elevation.lacunarity));
      const moist = norm01(fbm(moistNoise, x, y, NOISE_PARAMS.moisture.octaves, NOISE_PARAMS.moisture.frequency, NOISE_PARAMS.moisture.persistence, NOISE_PARAMS.moisture.lacunarity));
      const spot = norm01(fbm(spotNoise, x, y, 2, 0.15, 0.5, 2));
      let type = classifyBiome(elev, moist);
      if (type === "mushroom" /* Mushroom */ && spot < 0.4) {
        type = "grass" /* Grass */;
      }
      const resources = tileResourceValues(type, elev, moist, rng);
      grid2[y][x] = { type, ...resources };
    }
  }
  const SPAWN_W = 24, SPAWN_H = 10;
  const MARGIN = 4;
  let bestSpawnX = Math.floor(GRID_SIZE / 2 - SPAWN_W / 2);
  let bestSpawnY = Math.floor(GRID_SIZE / 2 - SPAWN_H / 2);
  let bestScore = -1;
  const minFoodThreshold = Math.floor(20 * (GRID_SIZE / 64) ** 2);
  const candidates = [];
  for (let i = 0; i < 40; i++) {
    candidates.push({
      x: MARGIN + Math.floor(rng() * (GRID_SIZE - SPAWN_W - MARGIN * 2)),
      y: MARGIN + Math.floor(rng() * (GRID_SIZE - SPAWN_H - MARGIN * 2))
    });
  }
  candidates.push({ x: bestSpawnX, y: bestSpawnY });
  for (const c of candidates) {
    let walkable = 0;
    for (let dy = 0; dy < SPAWN_H; dy++) {
      for (let dx = 0; dx < SPAWN_W; dx++) {
        const t = grid2[c.y + dy]?.[c.x + dx];
        if (t && t.type !== "water" /* Water */) walkable++;
      }
    }
    if (walkable < SPAWN_W * SPAWN_H * 0.8) continue;
    const cx = c.x + Math.floor(SPAWN_W / 2);
    const cy = c.y + Math.floor(SPAWN_H / 2);
    let food = countNearbyFoodTiles(grid2, cx, cy, 15);
    if (food > minFoodThreshold * 2) {
      food = minFoodThreshold * 2;
    }
    if (food > bestScore) {
      bestScore = food;
      bestSpawnX = c.x;
      bestSpawnY = c.y;
    }
  }
  const spawnZone2 = { x: bestSpawnX, y: bestSpawnY, w: SPAWN_W, h: SPAWN_H };
  const spawnCx2 = spawnZone2.x + Math.floor(spawnZone2.w / 2);
  const spawnCy2 = spawnZone2.y + Math.floor(spawnZone2.h / 2);
  const foodCheckRadius = Math.floor(15 * GRID_SIZE / 64);
  const nearbyFood = countNearbyFoodTiles(grid2, spawnCx2, spawnCx2, foodCheckRadius);
  if (nearbyFood < minFoodThreshold) {
    const patchCount = Math.floor(10 * (GRID_SIZE / 64) ** 2);
    for (let i = 0; i < patchCount; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = 5 + rng() * 10;
      const px = Math.max(2, Math.min(GRID_SIZE - 3, Math.round(spawnCx2 + Math.cos(angle) * dist)));
      const py = Math.max(2, Math.min(GRID_SIZE - 3, Math.round(spawnCy2 + Math.sin(angle) * dist)));
      seedMushroomPatch(grid2, px, py, rng);
    }
  }
  return { grid: grid2, spawnZone: spawnZone2, seed: worldSeed };
}
var WOOD_GROWBACK_RATE = 0.02;
var YEAR_CYCLE_TICKS = 2400;
function growback(grid2, growbackMod = 1, tick = 0) {
  const seasonalMod = 1 + 0.3 * Math.sin(tick / YEAR_CYCLE_TICKS * 2 * Math.PI);
  const effectiveMod = growbackMod * seasonalMod;
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const t = grid2[y][x];
      if (t.growbackRate > 0 && t.maxFood > 0 && t.foodValue < t.maxFood) {
        t.foodValue = Math.min(t.maxFood, t.foodValue + t.growbackRate * effectiveMod);
      }
      if (t.type === "forest" /* Forest */ && t.maxMaterial > 0 && t.materialValue < t.maxMaterial) {
        t.materialValue = Math.min(t.maxMaterial, t.materialValue + WOOD_GROWBACK_RATE * effectiveMod);
      }
    }
  }
}
function isWalkable(grid2, x, y) {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return false;
  const t = grid2[y][x].type;
  return t !== "water" /* Water */ && t !== "wall" /* Wall */;
}

// src/simulation/fire.ts
var FLAMMABLE = /* @__PURE__ */ new Set(["grass" /* Grass */, "forest" /* Forest */, "mushroom" /* Mushroom */, "farmland" /* Farmland */, "treestump" /* TreeStump */]);
var FIRE_DURATION = 90;
var SPREAD_INTERVAL = 25;
var BASE_IGNITION = 3e-4;
var BASE_SPREAD = 0.8;
var RAIN_EXTINGUISH = 0.25;
var FIRE_DAMAGE_HP = 5;
var FIRE_DAMAGE_MOR = 3;
var GOBLIN_CATCH_FIRE_CHANCE = 0.15;
var ON_FIRE_DAMAGE_HP = 2;
var ON_FIRE_DURATION = 50;
var ON_FIRE_TERRAIN_CHANCE = 0.04;
var FRIENDLY_EXTINGUISH = 0.2;
var EXTINGUISH_TILES = /* @__PURE__ */ new Set(["water" /* Water */, "pool" /* Pool */]);
function weatherMod(weatherType) {
  switch (weatherType) {
    case "drought":
      return { ignition: 3, spread: 1.2, extinguish: 0 };
    case "rain":
      return { ignition: 0, spread: 0, extinguish: RAIN_EXTINGUISH };
    case "storm":
      return { ignition: 0, spread: 0, extinguish: RAIN_EXTINGUISH * 1.5 };
    // heavy rain kills fire fast
    case "cold":
      return { ignition: 0.5, spread: 0.6, extinguish: 0 };
    default:
      return { ignition: 1, spread: 1, extinguish: 0 };
  }
}
var DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
function tickFire(grid2, currentTick, goblins2, weatherType, onLog) {
  const mod = weatherMod(weatherType);
  const newFires = [];
  const burnouts = [];
  const extinguished = [];
  let loggedIgnition = false;
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const t = grid2[y][x];
      if (t.type === "hearth" /* Hearth */) {
        if (mod.ignition === 0) continue;
        for (const [dx, dy] of DIRS) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
          const n = grid2[ny][nx];
          if (FLAMMABLE.has(n.type) && Math.random() < BASE_IGNITION * mod.ignition) {
            newFires.push({ x: nx, y: ny });
            if (!loggedIgnition) {
              onLog?.(`\u{1F525} A hearth has set ${n.type} ablaze!`, "warn");
              loggedIgnition = true;
            }
          }
        }
      } else if (t.type === "fire" /* Fire */) {
        const age = currentTick - (t.fireTick ?? currentTick);
        if (mod.extinguish > 0 && Math.random() < mod.extinguish) {
          extinguished.push({ x, y });
          continue;
        }
        if (age >= FIRE_DURATION) {
          burnouts.push({ x, y });
        } else if (mod.spread > 0 && age % SPREAD_INTERVAL === 0 && age > 0) {
          const p = Math.min(0.95, BASE_SPREAD * mod.spread);
          for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
            const n = grid2[ny][nx];
            if (FLAMMABLE.has(n.type) && Math.random() < p) {
              newFires.push({ x: nx, y: ny });
            }
          }
        }
      }
    }
  }
  for (const { x, y } of extinguished) {
    const t = grid2[y][x];
    grid2[y][x] = { type: "dirt" /* Dirt */, foodValue: 0, maxFood: 0, materialValue: 0, maxMaterial: 0, growbackRate: 0, trafficScore: t.trafficScore };
  }
  for (const { x, y } of newFires) {
    const t = grid2[y][x];
    if (t.type === "fire" /* Fire */) continue;
    grid2[y][x] = { ...t, type: "fire" /* Fire */, foodValue: 0, maxFood: 0, materialValue: 0, maxMaterial: 0, growbackRate: 0, fireTick: currentTick };
  }
  for (const { x, y } of burnouts) {
    const t = grid2[y][x];
    grid2[y][x] = { type: "dirt" /* Dirt */, foodValue: 0, maxFood: 0, materialValue: 0, maxMaterial: 0, growbackRate: 0, trafficScore: t.trafficScore };
  }
  for (const g of goblins2) {
    if (!g.alive) continue;
    const tile = grid2[g.y]?.[g.x];
    if (tile?.type !== "fire" /* Fire */) continue;
    g.health -= FIRE_DAMAGE_HP;
    g.morale = Math.max(0, g.morale - FIRE_DAMAGE_MOR);
    if (g.health <= 0) {
      g.alive = false;
      g.health = 0;
      g.task = "dead";
      g.causeOfDeath = "burned alive";
      onLog?.(`\u{1F480} ${g.name} burned alive!`, "error");
    } else if (!g.onFire && Math.random() < GOBLIN_CATCH_FIRE_CHANCE) {
      g.onFire = true;
      g.onFireTick = currentTick;
      onLog?.(`\u{1F525} ${g.name} caught fire!`, "warn");
    }
  }
  return { burnouts: burnouts.length + extinguished.length, extinguished: extinguished.length };
}
function tickBurningGoblins(grid2, currentTick, goblins2, onLog) {
  for (const g of goblins2) {
    if (!g.alive || !g.onFire) continue;
    g.health -= ON_FIRE_DAMAGE_HP;
    g.morale = Math.max(0, g.morale - 1);
    if (g.health <= 0) {
      g.alive = false;
      g.health = 0;
      g.task = "dead";
      g.causeOfDeath = "burned alive";
      g.onFire = false;
      onLog?.(`\u{1F480} ${g.name} burned to a crisp!`, "error");
      continue;
    }
    const age = currentTick - (g.onFireTick ?? currentTick);
    if (age >= ON_FIRE_DURATION) {
      g.onFire = false;
      onLog?.(`${g.name}'s flames finally went out.`, "info");
      continue;
    }
    const tile = grid2[g.y]?.[g.x];
    if (tile && EXTINGUISH_TILES.has(tile.type)) {
      g.onFire = false;
      g.morale = Math.max(0, g.morale - 5);
      onLog?.(`\u{1F4A7} ${g.name} dove into the water and put themselves out!`, "warn");
      continue;
    }
    if (tile && FLAMMABLE.has(tile.type) && Math.random() < ON_FIRE_TERRAIN_CHANCE) {
      grid2[g.y][g.x] = {
        ...tile,
        type: "fire" /* Fire */,
        foodValue: 0,
        maxFood: 0,
        materialValue: 0,
        maxMaterial: 0,
        growbackRate: 0,
        fireTick: currentTick
      };
    }
    const helpers = goblins2.filter(
      (o) => o.alive && !o.onFire && o.id !== g.id && Math.abs(o.x - g.x) <= 1 && Math.abs(o.y - g.y) <= 1
    );
    if (helpers.length > 0 && Math.random() < FRIENDLY_EXTINGUISH) {
      const helper = helpers[Math.floor(Math.random() * helpers.length)];
      g.onFire = false;
      onLog?.(`\u{1F91D} ${helper.name} beat the flames off ${g.name}!`, "warn");
    }
  }
}

// src/simulation/lightning.ts
var BASE_LIGHTNING_CHANCE = 0.02;
var FLAMMABLE2 = /* @__PURE__ */ new Set([
  "grass" /* Grass */,
  "forest" /* Forest */,
  "mushroom" /* Mushroom */,
  "farmland" /* Farmland */,
  "treestump" /* TreeStump */
]);
var ABSORB = /* @__PURE__ */ new Set(["water" /* Water */, "pool" /* Pool */, "fire" /* Fire */]);
function tickLightning(grid2, currentTick, weatherType, onLog) {
  if (weatherType !== "storm") return;
  if (Math.random() >= BASE_LIGHTNING_CHANCE) return;
  const x = Math.floor(Math.random() * GRID_SIZE);
  const y = Math.floor(Math.random() * GRID_SIZE);
  const t = grid2[y][x];
  if (ABSORB.has(t.type)) {
    return;
  }
  if (FLAMMABLE2.has(t.type)) {
    grid2[y][x] = {
      ...t,
      type: "fire" /* Fire */,
      foodValue: 0,
      maxFood: 0,
      materialValue: 0,
      maxMaterial: 0,
      growbackRate: 0,
      fireTick: currentTick
    };
    onLog?.(`\u26A1 Lightning struck ${t.type} at (${x},${y}) \u2014 it's on fire!`, "warn");
  } else {
    grid2[y][x] = {
      type: "dirt" /* Dirt */,
      foodValue: 0,
      maxFood: 0,
      materialValue: 0,
      maxMaterial: 0,
      growbackRate: 0,
      trafficScore: t.trafficScore
    };
    onLog?.(`\u26A1 Lightning struck ${t.type} at (${x},${y}).`, "info");
  }
}

// src/simulation/pooling.ts
var POOL_SOURCES = /* @__PURE__ */ new Set(["water" /* Water */, "pool" /* Pool */]);
var POOL_ELIGIBLE = /* @__PURE__ */ new Set(["dirt" /* Dirt */, "grass" /* Grass */, "farmland" /* Farmland */]);
var POOL_CHANCE_RAIN = 1e-3;
var POOL_MIN_AGE = 80;
var POOL_EVAP_CHANCE = 8e-3;
var POOL_EVAP_DROUGHT = 0.05;
var DIRS2 = [[-1, 0], [1, 0], [0, -1], [0, 1]];
function hasAdjacentSource(grid2, x, y) {
  for (const [dx, dy] of DIRS2) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
    if (POOL_SOURCES.has(grid2[ny][nx].type)) return true;
  }
  return false;
}
function tickPooling(grid2, currentTick, weatherType) {
  const isRaining = weatherType === "rain" || weatherType === "storm";
  const isDrought = weatherType === "drought";
  const evapChance = isDrought ? POOL_EVAP_DROUGHT : POOL_EVAP_CHANCE;
  const poolChance = weatherType === "storm" ? POOL_CHANCE_RAIN * 3 : POOL_CHANCE_RAIN;
  const newPools = [];
  const evaporate = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const t = grid2[y][x];
      if (isRaining && POOL_ELIGIBLE.has(t.type)) {
        if (hasAdjacentSource(grid2, x, y) && Math.random() < poolChance) {
          newPools.push({ x, y, prior: t.type });
        }
      } else if (t.type === "pool" /* Pool */) {
        const age = currentTick - (t.poolTick ?? currentTick);
        if (!isRaining && age >= POOL_MIN_AGE && Math.random() < evapChance) {
          evaporate.push({ x, y });
        }
      }
    }
  }
  for (const { x, y, prior } of newPools) {
    const t = grid2[y][x];
    grid2[y][x] = {
      ...t,
      type: "pool" /* Pool */,
      foodValue: 0,
      maxFood: 0,
      growbackRate: 0,
      poolTick: currentTick,
      priorType: prior
    };
  }
  for (const { x, y } of evaporate) {
    const t = grid2[y][x];
    const restored = t.priorType ?? "dirt" /* Dirt */;
    grid2[y][x] = {
      type: restored,
      foodValue: 0,
      maxFood: restored === "grass" /* Grass */ ? 4 : 0,
      materialValue: 0,
      maxMaterial: 0,
      growbackRate: restored === "grass" /* Grass */ ? 0.04 : restored === "farmland" /* Farmland */ ? 0.02 : 0,
      trafficScore: t.trafficScore
    };
  }
}

// src/shared/factions.ts
var GOBLIN_FACTION = {
  unitNoun: "goblin",
  unitNounPlural: "goblins",
  title: "KOBOLD",
  subtitle: "goblin colony sim",
  startHint: "chaos awaits",
  accentColor: "#f0c040",
  names: [
    "Grix",
    "Snot",
    "Murg",
    "Blix",
    "Rak",
    "Nub",
    "Fizzle",
    "Blort",
    "Skritch",
    "Gob"
  ],
  bios: [
    "ate a rock once and liked it",
    "has an imaginary friend named Keith",
    "claims to have invented fire",
    "afraid of loud noises and also quiet ones",
    "once stole a sword bigger than himself",
    "was kicked out of three different caves",
    "firmly believes the moon is edible",
    "has a pet spider named Lord Bitington",
    "convinced he can talk to mushrooms",
    "lost a fight to a particularly aggressive squirrel"
  ],
  goals: [
    "eat something that isn't a bug",
    "find a rock that looks like a face",
    "go one whole day without being hit",
    "make a friend (a real one this time)",
    "find something shiny",
    "build something that doesn't fall down",
    "survive until lunch",
    'learn what a "plan" is'
  ],
  traitDisplay: {
    helpful: "Surprisingly Generous",
    greedy: "Shinies Hoarder",
    brave: "Too Dumb to Run",
    paranoid: "Sensibly Cautious",
    lazy: "Professional Napper",
    cheerful: "Annoyingly Cheerful",
    mean: "Bitey",
    forgetful: "What Was I Doing?"
  },
  roleDisplay: {
    forager: "SCAVENGER",
    miner: "ROCK BITER",
    scout: "SNEAKY GIT",
    fighter: "BASHER",
    lumberjack: "TREE PUNCHER"
  },
  llmSpecies: "goblin",
  llmRoleLabels: {
    forager: "Scavenger \u2014 you find food that hasn't gone completely bad yet.",
    miner: "Rock Biter \u2014 you chew through stone and sometimes find shiny things.",
    scout: "Sneaky Git \u2014 you have wide vision and detect threats early (mostly by being paranoid).",
    fighter: "Basher \u2014 you clobber adventurers who dare enter the colony.",
    lumberjack: "Tree Puncher \u2014 you punch trees until they fall down (usually)."
  },
  narratorTone: "darkly humorous, chaotic, told with affection for the hapless goblins",
  successionPrompt: "You are {name}, a new goblin stumbling into a chaotic colony. {deadName} ({deadRole}) recently died here.{memSnippet} In one sentence (max 15 words), what is your first thought? Be funny and goblin-like. Reply with just the sentence, no quotes.",
  killVerb: "clobbered",
  raidSuffix: "Run!",
  enemyNounPlural: "adventurers",
  goalDescriptions: {
    stockpile_food: (t) => `Hoard ${t} food (without eating it all)`,
    survive_ticks: (t) => `Don't all die for ${t} ticks`,
    defeat_adventurers: (t) => `Clobber ${t} adventurers`,
    enclose_fort: () => "Build walls (that hopefully stay up)"
  }
};
function getActiveFaction() {
  return GOBLIN_FACTION;
}

// src/simulation/agents/roles.ts
var ROLE_ORDER = ["forager", "miner", "scout", "lumberjack", "fighter"];
var ROLE_COMBAT_APT = {
  fighter: 1,
  scout: 0.25,
  miner: 0.15,
  forager: 0.15,
  lumberjack: 0.15
};
var ROLE_MINING_APT = {
  miner: 1,
  fighter: 0.15,
  scout: 0.15,
  forager: 0.1,
  lumberjack: 0.15
};
var ROLE_CHOP_APT = {
  lumberjack: 1,
  scout: 0.15,
  miner: 0.1,
  forager: 0.1,
  fighter: 0.1
};
var TRAIT_MODS = {
  helpful: { shareThreshold: 6, shareDonorKeeps: 3, shareRelationGate: 15, lonelinessCrisisThreshold: 55, generosityRange: 3 },
  greedy: { shareThreshold: 12, shareDonorKeeps: 8, generosityRange: 1 },
  brave: { fleeThreshold: 95, moraleCrisisThreshold: 30, healthBonus: 20, huntRange: 2.5 },
  paranoid: { fleeThreshold: 60, wanderHomeDrift: 0.5, moraleCrisisThreshold: 50, hungerCrisisThreshold: 55, perceptiveness: 2, wariness: 4, healthBonus: -10 },
  lazy: { eatThreshold: 55, fatigueRate: 1.3, exhaustionThreshold: 65, hungerCrisisThreshold: 58 },
  cheerful: { shareThreshold: 6, shareRelationGate: 20, socialDecayBonus: 0.15, generosityRange: 3 },
  mean: { shareThreshold: 14, contestPenalty: -10, shareRelationGate: 55, lonelinessCrisisThreshold: 85, generosityRange: 1 },
  forgetful: {}
};
function traitMod(goblin, key, fallback) {
  return TRAIT_MODS[goblin.trait]?.[key] ?? fallback;
}
var GOBLIN_TRAIT_DISPLAY = new Proxy({}, {
  get: (_target, prop) => getActiveFaction().traitDisplay[prop]
});
var GOBLIN_ROLE_DISPLAY = new Proxy({}, {
  get: (_target, prop) => getActiveFaction().roleDisplay[prop]
});
var GOBLIN_TRAITS = [
  "lazy",
  "forgetful",
  "helpful",
  "mean",
  "paranoid",
  "brave",
  "greedy",
  "cheerful"
];
function getGoblinBios() {
  return getActiveFaction().bios;
}
function getGoblinGoals() {
  return getActiveFaction().goals;
}
var ROLE_STATS = {
  forager: { visionMin: 5, visionMax: 8, maxHealth: 100 },
  miner: { visionMin: 4, visionMax: 6, maxHealth: 100 },
  scout: { visionMin: 7, visionMax: 12, maxHealth: 100 },
  fighter: { visionMin: 4, visionMax: 7, maxHealth: 130 },
  lumberjack: { visionMin: 5, visionMax: 8, maxHealth: 100 }
};

// src/simulation/agents/pathfinding.ts
import * as ROT from "rot-js";
function bestFoodTile(goblin, grid2, radius) {
  let best = null;
  let bestValue = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = goblin.x + dx;
      const ny = goblin.y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (!FORAGEABLE_TILES.has(grid2[ny][nx].type)) continue;
      if (grid2[ny][nx].foodValue < 1) continue;
      const dist = Math.abs(dx) + Math.abs(dy);
      const v = grid2[ny][nx].foodValue - dist;
      if (v > bestValue) {
        bestValue = v;
        best = { x: nx, y: ny };
      }
    }
  }
  return best;
}
function bestMaterialTile(goblin, grid2, radius) {
  let best = null;
  let bestValue = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = goblin.x + dx;
      const ny = goblin.y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (grid2[ny][nx].type === "forest" /* Forest */) continue;
      if (grid2[ny][nx].materialValue < 1) continue;
      const dist = Math.abs(dx) + Math.abs(dy);
      const v = grid2[ny][nx].materialValue - dist;
      if (v > bestValue) {
        bestValue = v;
        best = { x: nx, y: ny };
      }
    }
  }
  return best;
}
function bestWoodTile(goblin, grid2, radius) {
  let best = null;
  let bestValue = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = goblin.x + dx;
      const ny = goblin.y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (grid2[ny][nx].type !== "forest" /* Forest */) continue;
      if (grid2[ny][nx].materialValue < 1) continue;
      const dist = Math.abs(dx) + Math.abs(dy);
      const v = grid2[ny][nx].materialValue - dist;
      if (v > bestValue) {
        bestValue = v;
        best = { x: nx, y: ny };
      }
    }
  }
  return best;
}
function pathNextStep(from, to, grid2) {
  if (from.x === to.x && from.y === to.y) return from;
  const path = [];
  const astar = new ROT.Path.AStar(
    to.x,
    to.y,
    (x, y) => x === to.x && y === to.y || isWalkable(grid2, x, y),
    { topology: 4 }
  );
  astar.compute(from.x, from.y, (x, y) => path.push({ x, y }));
  return path[1] ?? from;
}

// src/simulation/agents/fort.ts
function roomWallSlots(rooms2, grid2, goblins2, selfId, adventurers2) {
  const slots = [];
  const added = /* @__PURE__ */ new Set();
  const blocked = (x, y) => {
    if (goblins2?.some((d) => d.alive && d.id !== selfId && d.x === x && d.y === y)) return true;
    if (adventurers2?.some((g) => g.x === x && g.y === y)) return true;
    return false;
  };
  const tryAdd = (x, y) => {
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;
    const key = `${x},${y}`;
    if (added.has(key)) return;
    const t = grid2[y][x];
    if (t.type === "wall" /* Wall */ || t.type === "water" /* Water */ || t.type === "ore" /* Ore */ || t.type === "stone" /* Stone */ || t.type === "pool" /* Pool */) return;
    if (blocked(x, y)) return;
    added.add(key);
    slots.push({ x, y });
  };
  for (const room of rooms2) {
    const doorTop = { x: room.x + 2, y: room.y - 1 };
    const doorBottom = { x: room.x + 2, y: room.y + room.h };
    const doorLeft = { x: room.x - 1, y: room.y + 2 };
    const doorRight = { x: room.x + room.w, y: room.y + 2 };
    const isDoor = (x, y) => x === doorTop.x && y === doorTop.y || x === doorBottom.x && y === doorBottom.y || x === doorLeft.x && y === doorLeft.y || x === doorRight.x && y === doorRight.y;
    for (let x = room.x - 1; x <= room.x + room.w; x++) {
      if (!isDoor(x, room.y - 1)) tryAdd(x, room.y - 1);
    }
    for (let x = room.x - 1; x <= room.x + room.w; x++) {
      if (!isDoor(x, room.y + room.h)) tryAdd(x, room.y + room.h);
    }
    for (let y = room.y; y < room.y + room.h; y++) {
      if (!isDoor(room.x - 1, y)) tryAdd(room.x - 1, y);
    }
    for (let y = room.y; y < room.y + room.h; y++) {
      if (!isDoor(room.x + room.w, y)) tryAdd(room.x + room.w, y);
    }
  }
  return slots;
}

// src/simulation/skills.ts
function xpToLevel(xp) {
  return Math.floor(Math.sqrt(xp / 10));
}
function grantXp(goblin, _tick, onLog) {
  goblin.skillXp += 1;
  const newLevel = xpToLevel(goblin.skillXp);
  if (newLevel > goblin.skillLevel) {
    goblin.skillLevel = newLevel;
    onLog?.(`\u2B50 leveled up to ${goblin.role} Lv.${newLevel}!`, "info");
    return true;
  }
  return false;
}
function skillYieldBonus(goblin) {
  if (goblin.role !== "forager" && goblin.role !== "lumberjack") return 0;
  return goblin.skillLevel * 0.3;
}
function skillOreBonus(goblin) {
  if (goblin.role !== "miner") return 0;
  return goblin.skillLevel * 0.3;
}
function skillDamageBonus(goblin) {
  if (goblin.role !== "fighter") return 0;
  return goblin.skillLevel * 3;
}
function skillVisionBonus(goblin) {
  if (goblin.role !== "scout") return 0;
  return goblin.skillLevel;
}

// src/simulation/agents/spawn.ts
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function toRoman(n) {
  const vals = [1e3, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ["M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"];
  let result = "";
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) {
      result += syms[i];
      n -= vals[i];
    }
  }
  return result;
}
function spawnGoblins(grid2, spawnZone2) {
  const goblins2 = [];
  for (let i = 0; i < INITIAL_GOBLINS; i++) {
    let x, y;
    do {
      x = spawnZone2.x + rand(0, spawnZone2.w - 1);
      y = spawnZone2.y + rand(0, spawnZone2.h - 1);
    } while (!isWalkable(grid2, x, y));
    const role = ROLE_ORDER[i % ROLE_ORDER.length];
    const stats = ROLE_STATS[role];
    const trait = GOBLIN_TRAITS[Math.floor(Math.random() * GOBLIN_TRAITS.length)];
    const healthBonus = TRAIT_MODS[trait]?.healthBonus ?? 0;
    const maxHealth = Math.max(10, stats.maxHealth + healthBonus);
    const factionNames = getActiveFaction().names;
    const baseName = factionNames[i % factionNames.length];
    goblins2.push({
      id: `goblin-${i}`,
      name: baseName,
      baseName,
      generation: 1,
      x,
      y,
      health: maxHealth,
      maxHealth,
      hunger: rand(10, 30),
      metabolism: Math.round((0.15 + Math.random() * 0.2) * 100) / 100,
      vision: rand(stats.visionMin, stats.visionMax),
      inventory: { food: rand(8, 15), ore: 0, wood: 0 },
      morale: 70 + rand(0, 20),
      alive: true,
      task: "idle",
      role,
      commandTarget: null,
      llmReasoning: null,
      llmIntent: null,
      llmIntentExpiry: 0,
      memory: [],
      relations: {},
      trait,
      bio: getGoblinBios()[Math.floor(Math.random() * getGoblinBios().length)],
      goal: getGoblinGoals()[Math.floor(Math.random() * getGoblinGoals().length)],
      wanderTarget: null,
      wanderExpiry: 0,
      knownFoodSites: [],
      knownOreSites: [],
      knownWoodSites: [],
      knownHearthSites: [],
      homeTile: { x: 0, y: 0 },
      adventurerKills: 0,
      fatigue: 0,
      social: 0,
      lastSocialTick: 0,
      lastLoggedTicks: { morale_high: 0 },
      skillXp: 0,
      skillLevel: 0
    });
  }
  return goblins2;
}
var SUCCESSION_DELAY = 300;
function spawnSuccessor(dead, grid2, spawnZone2, allDwarves, tick) {
  const baseName = dead.baseName;
  const generation = dead.generation + 1;
  const name = generation === 1 ? baseName : `${baseName} ${toRoman(generation)}`;
  const role = ROLE_ORDER[Math.floor(Math.random() * ROLE_ORDER.length)];
  const stats = ROLE_STATS[role];
  const trait = GOBLIN_TRAITS[Math.floor(Math.random() * GOBLIN_TRAITS.length)];
  const healthBonus = TRAIT_MODS[trait]?.healthBonus ?? 0;
  const maxHealth = Math.max(10, stats.maxHealth + healthBonus);
  let x, y;
  do {
    x = spawnZone2.x + rand(0, spawnZone2.w - 1);
    y = spawnZone2.y + rand(0, spawnZone2.h - 1);
  } while (!isWalkable(grid2, x, y));
  const inheritedMemory = dead.memory.slice(-2).map((m) => ({
    tick,
    crisis: "inheritance",
    action: `${dead.name} once: "${m.action}"`,
    outcome: m.outcome
  }));
  if (dead.causeOfDeath) {
    inheritedMemory.unshift({
      tick,
      crisis: "inheritance",
      action: `${dead.name} died of ${dead.causeOfDeath}`
    });
  }
  const sortedRels = Object.entries(dead.relations).sort(([, a], [, b]) => b - a);
  const topAlly = sortedRels.find(([, s]) => s > 60);
  const topRival = [...sortedRels].reverse().find(([, s]) => s < 40);
  if (topAlly) {
    const allyDwarf = allDwarves.find((d) => d.id === topAlly[0]);
    if (allyDwarf) inheritedMemory.push({
      tick,
      crisis: "inheritance",
      action: `${dead.name}'s closest companion was ${allyDwarf.name}`
    });
  }
  if (topRival) {
    const rivalDwarf = allDwarves.find((d) => d.id === topRival[0]);
    if (rivalDwarf) inheritedMemory.push({
      tick,
      crisis: "inheritance",
      action: `${dead.name}'s greatest rival was ${rivalDwarf.name}`
    });
  }
  const relations = {};
  for (const [id2, score] of Object.entries(dead.relations)) {
    relations[id2] = Math.round(50 + (score - 50) * 0.5);
  }
  return {
    id: `goblin-${Date.now()}`,
    name,
    baseName,
    generation,
    x,
    y,
    health: maxHealth,
    maxHealth,
    hunger: rand(10, 30),
    metabolism: Math.round((0.15 + Math.random() * 0.2) * 100) / 100,
    vision: rand(stats.visionMin, stats.visionMax),
    inventory: { food: rand(5, 12), ore: 0, wood: 0 },
    morale: 60 + rand(0, 20),
    alive: true,
    task: "just arrived",
    role,
    commandTarget: null,
    llmReasoning: null,
    llmIntent: null,
    llmIntentExpiry: 0,
    memory: inheritedMemory,
    relations,
    trait,
    bio: getGoblinBios()[Math.floor(Math.random() * getGoblinBios().length)],
    goal: getGoblinGoals()[Math.floor(Math.random() * getGoblinGoals().length)],
    wanderTarget: null,
    wanderExpiry: 0,
    knownFoodSites: [],
    knownOreSites: [],
    knownWoodSites: [],
    knownHearthSites: [],
    homeTile: { x: 0, y: 0 },
    adventurerKills: 0,
    fatigue: 0,
    social: 0,
    lastSocialTick: 0,
    lastLoggedTicks: { morale_high: 0 },
    skillXp: Math.floor(dead.skillXp * 0.25),
    skillLevel: xpToLevel(Math.floor(dead.skillXp * 0.25))
  };
}

// src/simulation/diffusion.ts
var N = GRID_SIZE * GRID_SIZE;
var WARMTH_RADIUS = 8;
var SHELTER_PER_WALL = 0.15;
var SHELTER_MAX_MULT = 1.5;
var DANGER_RADIUS_ADV = 12;
var DANGER_RADIUS_EDGE = 4;
var DANGER_DECAY = 0.97;
var TRAFFIC_DECAY = 0.998;
var TRAFFIC_INCREMENT = 0.5;
var TRAFFIC_CAP = 100;
function idx(x, y) {
  return y * GRID_SIZE + x;
}
function createWarmthField() {
  return new Float32Array(N);
}
function createDangerField() {
  return new Float32Array(N);
}
function findHearths(grid2) {
  const out = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      if (grid2[y][x].type === "hearth" /* Hearth */) out.push({ x, y });
    }
  }
  return out;
}
function computeWarmth(grid2, hearths, foodStockpiles2, weatherType, out) {
  out.fill(0);
  const queue = [];
  for (const h of hearths) queue.push([h.x, h.y, 100]);
  for (const s of foodStockpiles2) queue.push([s.x, s.y, 60]);
  for (let fy = 0; fy < GRID_SIZE; fy++) {
    for (let fx = 0; fx < GRID_SIZE; fx++) {
      if (grid2[fy][fx].type === "fire" /* Fire */) queue.push([fx, fy, 70]);
    }
  }
  const STEP = 100 / WARMTH_RADIUS;
  const DIRS3 = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  let head = 0;
  while (head < queue.length) {
    const [x, y, strength] = queue[head++];
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
    const i = idx(x, y);
    if (out[i] >= strength) continue;
    out[i] = strength;
    const t = grid2[y][x];
    if (t.type === "wall" /* Wall */ && strength < 99) continue;
    const next = strength - STEP;
    if (next <= 0) continue;
    for (const [dx, dy] of DIRS3) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (out[idx(nx, ny)] < next) queue.push([nx, ny, next]);
    }
  }
  const DIRS8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const i = idx(x, y);
      if (out[i] <= 0) continue;
      let walls = 0;
      for (const [dx, dy] of DIRS8) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE && grid2[ny][nx].type === "wall" /* Wall */) walls++;
      }
      if (walls > 0) {
        const mult = Math.min(SHELTER_MAX_MULT, 1 + walls * SHELTER_PER_WALL);
        out[i] = Math.min(100, out[i] * mult);
      }
    }
  }
  if (weatherType === "cold") {
    for (let i = 0; i < N; i++) out[i] *= 0.7;
  }
}
function computeDanger(grid2, adventurers2, prev, out) {
  for (let i = 0; i < N; i++) out[i] = prev[i] * DANGER_DECAY;
  const fresh = new Float32Array(N);
  const STEP_ADV = 100 / DANGER_RADIUS_ADV;
  const STEP_EDGE = 40 / DANGER_RADIUS_EDGE;
  const DIRS3 = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const queue = [];
  for (const a of adventurers2) queue.push([a.x, a.y, 100]);
  for (let fy = 0; fy < GRID_SIZE; fy++) {
    for (let fx = 0; fx < GRID_SIZE; fx++) {
      if (grid2[fy][fx].type === "fire" /* Fire */) queue.push([fx, fy, 80]);
    }
  }
  for (let x = 0; x < GRID_SIZE; x++) {
    queue.push([x, 0, 40]);
    queue.push([x, GRID_SIZE - 1, 40]);
  }
  for (let y = 0; y < GRID_SIZE; y++) {
    queue.push([0, y, 40]);
    queue.push([GRID_SIZE - 1, y, 40]);
  }
  let head = 0;
  while (head < queue.length) {
    const [x, y, strength] = queue[head++];
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
    const i = idx(x, y);
    if (fresh[i] >= strength) continue;
    fresh[i] = strength;
    const t = grid2[y][x];
    const step = strength > 40 ? STEP_ADV : STEP_EDGE;
    let next = strength - step;
    if (t.type === "wall" /* Wall */) next *= 0.5;
    if (next <= 0) continue;
    for (const [dx, dy] of DIRS3) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (fresh[idx(nx, ny)] < next) queue.push([nx, ny, next]);
    }
  }
  for (let i = 0; i < N; i++) {
    out[i] = Math.min(100, Math.max(out[i], fresh[i]));
  }
}
function updateTraffic(grid2, goblins2) {
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const t = grid2[y][x];
      if ((t.trafficScore ?? 0) > 0) {
        t.trafficScore = t.trafficScore * TRAFFIC_DECAY;
      }
    }
  }
  for (const g of goblins2) {
    if (!g.alive) continue;
    const t = grid2[g.y]?.[g.x];
    if (t) t.trafficScore = Math.min(TRAFFIC_CAP, (t.trafficScore ?? 0) + TRAFFIC_INCREMENT);
  }
}
function getWarmth(field, x, y) {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return 0;
  return field[y * GRID_SIZE + x];
}
function getDanger(field, x, y) {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return 0;
  return field[y * GRID_SIZE + x];
}

// src/simulation/wounds.ts
var WOUND_TABLE = [
  { type: "bruised", chance: 0.3, duration: 80, label: "bruised" },
  { type: "leg", chance: 0.45, duration: 150, label: "leg wound" },
  { type: "arm", chance: 0.55, duration: 120, label: "arm wound" },
  { type: "eye", chance: 0.6, duration: 200, label: "eye wound" }
];
function rollWound(goblin, tick) {
  if (goblin.wound) return void 0;
  const roll = Math.random();
  for (const def of WOUND_TABLE) {
    if (roll < def.chance) {
      return { type: def.type, healTick: tick + def.duration };
    }
  }
  return void 0;
}
function woundLabel(type) {
  return WOUND_TABLE.find((d) => d.type === type)?.label ?? type;
}
function effectiveVision(goblin) {
  let v = goblin.vision + skillVisionBonus(goblin);
  if (goblin.wound?.type === "eye") v -= 3;
  return Math.max(1, v);
}
function isLegWoundSkip(goblin) {
  return goblin.wound?.type === "leg" && Math.random() < 0.4;
}
function woundYieldMultiplier(goblin) {
  return goblin.wound?.type === "arm" ? 0.5 : 1;
}
function woundDamageMultiplier(goblin) {
  return goblin.wound?.type === "arm" ? 0.6 : 1;
}
function tickWoundHealing(goblin, tick, onLog) {
  if (!goblin.wound) return;
  if (tick >= goblin.wound.healTick) {
    const label = woundLabel(goblin.wound.type);
    goblin.wound = void 0;
    onLog?.(`\u{1F49A} ${label} has healed`, "info");
  }
}
function accelerateHealing(goblin, ticks) {
  if (goblin.wound) {
    goblin.wound.healTick -= ticks;
  }
}

// src/simulation/actions/helpers.ts
function totalLoad(inv) {
  return inv.food + inv.ore + inv.wood;
}
var TRAIT_FLAVOR = {
  lazy: { eat: "scarfed down food messily", rest: "collapsed into a heap", share: "grudgingly tossed over some food" },
  helpful: { eat: "gobbled food quickly", rest: "rested briefly", share: "excitedly shared" },
  greedy: { eat: "ate greedily, hiding scraps", rest: "rested atop his hoard", share: "painfully parted with some food" },
  brave: { eat: "ate without looking", rest: "caught breath mid-charge", share: "shared" },
  cheerful: { eat: "ate with a grin", rest: "napped with a smile", share: "gladly shared" },
  mean: { eat: "ate alone, growling", rest: "rested, glaring at everyone", share: "begrudgingly shared" },
  paranoid: { eat: "ate while looking around wildly", rest: "rested with both eyes open", share: "cautiously shared" },
  forgetful: { eat: "ate... wait, what?", rest: "dozed off mid-thought", share: "shared (forgot he gave it away)" }
};
function traitText(goblin, action) {
  return TRAIT_FLAVOR[goblin.trait]?.[action] ?? action;
}
function shouldLog(goblin, key, tick, cooldown) {
  if (tick - (goblin.lastLoggedTicks[key] ?? -Infinity) < cooldown) return false;
  goblin.lastLoggedTicks[key] = tick;
  return true;
}
function fatigueRate(goblin) {
  return traitMod(goblin, "fatigueRate", 1);
}
function moveTo(goblin, target, grid2) {
  if (isLegWoundSkip(goblin)) return;
  const next = pathNextStep({ x: goblin.x, y: goblin.y }, target, grid2);
  goblin.x = next.x;
  goblin.y = next.y;
  goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate(goblin));
}
function addWorkFatigue(goblin) {
  goblin.fatigue = Math.min(100, goblin.fatigue + 0.4 * fatigueRate(goblin));
}
function nearestFoodStockpile(goblin, stockpiles, filter) {
  return stockpiles?.filter(filter).reduce((best, s) => {
    const dist = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
    const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
    return dist < bestDist ? s : best;
  }, null) ?? null;
}
function nearestOreStockpile(goblin, stockpiles, filter) {
  return stockpiles?.filter(filter).reduce((best, s) => {
    const dist = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
    const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
    return dist < bestDist ? s : best;
  }, null) ?? null;
}
function nearestWoodStockpile(goblin, stockpiles, filter) {
  return stockpiles?.filter(filter).reduce((best, s) => {
    const dist = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
    const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
    return dist < bestDist ? s : best;
  }, null) ?? null;
}

// src/simulation/actions/survival.ts
var commandMove = {
  name: "commandMove",
  eligible: ({ goblin }) => goblin.commandTarget !== null,
  score: ({ goblin, adventurers: adventurers2 }) => {
    const raid = adventurers2 && adventurers2.length > 0;
    const starving = goblin.hunger >= 95 && goblin.inventory.food === 0 && goblin.inventory.meals === 0;
    return raid || starving ? 0.8 : 1;
  },
  execute: ({ goblin, grid: grid2, onLog }) => {
    const { x: tx, y: ty } = goblin.commandTarget;
    if (goblin.x === tx && goblin.y === ty) {
      onLog?.(`arrived at (${tx},${ty})`, "info");
      goblin.commandTarget = null;
      goblin.task = "arrived";
    } else {
      moveTo(goblin, goblin.commandTarget, grid2);
      goblin.task = `\u2192 (${tx},${ty})`;
    }
  }
};
var eat = {
  name: "eat",
  intentMatch: "eat",
  eligible: ({ goblin, grid: grid2 }) => {
    if (goblin.inventory.food > 0 || goblin.inventory.meals > 0) return true;
    const tile = grid2[goblin.y]?.[goblin.x];
    return !!tile && FORAGEABLE_TILES.has(tile.type) && tile.foodValue >= 1;
  },
  score: ({ goblin }) => {
    const mid = traitMod(goblin, "eatThreshold", 50);
    const score = sigmoid(goblin.hunger, mid);
    return goblin.hunger > 80 ? Math.min(1, score * 1.5) : score;
  },
  execute: ({ goblin, grid: grid2, currentTick, onLog }) => {
    const wasDesperatelyHungry = goblin.hunger > 80;
    if (goblin.inventory.meals > 0) {
      goblin.inventory.meals -= 1;
      goblin.hunger = Math.max(0, goblin.hunger - 50);
      goblin.morale = Math.min(100, goblin.morale + 10);
      goblin.task = "eating a meal";
    } else if (goblin.inventory.food > 0) {
      const bite = Math.min(goblin.inventory.food, 3);
      goblin.inventory.food -= bite;
      goblin.hunger = Math.max(0, goblin.hunger - bite * 20);
      goblin.task = "eating";
    } else {
      const tile = grid2[goblin.y]?.[goblin.x];
      if (!tile || tile.foodValue < 1) return;
      const bite = Math.min(tile.foodValue, 2);
      tile.foodValue -= bite;
      goblin.hunger = Math.max(0, goblin.hunger - bite * 20);
      goblin.task = "grazing";
    }
    if (wasDesperatelyHungry && shouldLog(goblin, "eat", currentTick, 200)) {
      onLog?.(`\u{1F356} ${traitText(goblin, "eat")} \u2014 was starving`, "warn");
    }
  }
};
var rest = {
  name: "rest",
  intentMatch: "rest",
  eligible: ({ goblin }) => goblin.hunger < 95,
  score: ({ goblin }) => {
    const base = sigmoid(goblin.fatigue, 50);
    const momentum = goblin.task.includes("resting") && goblin.fatigue > 30 ? 0.15 : 0;
    return Math.min(1, base + momentum);
  },
  execute: ({ goblin, warmthField: warmthField2 }) => {
    const warmth = warmthField2 ? getWarmth(warmthField2, goblin.x, goblin.y) : 0;
    if (warmth >= 40) {
      goblin.fatigue = Math.max(0, goblin.fatigue - 2.5);
      accelerateHealing(goblin, 3);
      goblin.morale = Math.min(100, goblin.morale + 0.3);
      goblin.task = goblin.wound ? `resting by the hearth (healing ${goblin.wound.type})` : "resting by the hearth";
    } else if (warmth >= 20) {
      goblin.fatigue = Math.max(0, goblin.fatigue - 2);
      accelerateHealing(goblin, 2);
      goblin.morale = Math.min(100, goblin.morale + 0.1);
      goblin.task = goblin.wound ? `resting near warmth (healing ${goblin.wound.type})` : "resting near warmth";
    } else {
      goblin.fatigue = Math.max(0, goblin.fatigue - 1.5);
      accelerateHealing(goblin, 2);
      goblin.task = goblin.wound ? `resting (healing ${goblin.wound.type})` : "resting";
    }
  }
};

// src/simulation/actions/social.ts
var share = {
  name: "share",
  eligible: ({ goblin, goblins: goblins2 }) => {
    if (!goblins2) return false;
    const shareThresh = traitMod(goblin, "shareThreshold", 8);
    if (goblin.inventory.food < shareThresh) return false;
    const relGate = traitMod(goblin, "shareRelationGate", 30);
    return goblins2.some(
      (d) => d.alive && d.id !== goblin.id && Math.abs(d.x - goblin.x) <= traitMod(goblin, "generosityRange", 2) && Math.abs(d.y - goblin.y) <= traitMod(goblin, "generosityRange", 2) && d.hunger > 60 && d.inventory.food < 3 && (goblin.relations[d.id] ?? 50) >= relGate
    );
  },
  score: ({ goblin, goblins: goblins2 }) => {
    if (!goblins2) return 0;
    const relGate = traitMod(goblin, "shareRelationGate", 30);
    const target = goblins2.filter(
      (d) => d.alive && d.id !== goblin.id && Math.abs(d.x - goblin.x) <= traitMod(goblin, "generosityRange", 2) && Math.abs(d.y - goblin.y) <= traitMod(goblin, "generosityRange", 2) && d.hunger > 60 && d.inventory.food < 3 && (goblin.relations[d.id] ?? 50) >= relGate
    ).sort((a, b) => b.hunger - a.hunger)[0];
    if (!target) return 0;
    return sigmoid(target.hunger, 70) * ramp(goblin.inventory.food, 6, 15) * inverseSigmoid(goblin.hunger, 50) * 0.8;
  },
  execute: ({ goblin, goblins: goblins2, currentTick, onLog }) => {
    if (!goblins2) return;
    const relGate = traitMod(goblin, "shareRelationGate", 30);
    const donorKeeps = traitMod(goblin, "shareDonorKeeps", 5);
    const target = goblins2.filter(
      (d) => d.alive && d.id !== goblin.id && Math.abs(d.x - goblin.x) <= traitMod(goblin, "generosityRange", 2) && Math.abs(d.y - goblin.y) <= traitMod(goblin, "generosityRange", 2) && d.hunger > 60 && d.inventory.food < 3 && (goblin.relations[d.id] ?? 50) >= relGate
    ).sort((a, b) => b.hunger - a.hunger)[0];
    if (!target) return;
    const give = Math.min(3, goblin.inventory.food - donorKeeps);
    if (give <= 0) return;
    const headroom = MAX_INVENTORY_CAPACITY - totalLoad(target.inventory);
    const actual = Math.min(give, headroom);
    if (actual <= 0) return;
    goblin.inventory.food -= actual;
    target.inventory.food += actual;
    const prevRel = goblin.relations[target.id] ?? 50;
    goblin.relations[target.id] = Math.min(100, prevRel + 5);
    target.relations[goblin.id] = Math.min(100, (target.relations[goblin.id] ?? 50) + 3);
    goblin.task = `shared ${actual.toFixed(0)} food \u2192 ${target.name}`;
    onLog?.(`\u{1F91D} ${traitText(goblin, "share")} ${actual.toFixed(0)} food with ${target.name}`, "info");
    if (prevRel < 70 && goblin.relations[target.id] >= 70 && shouldLog(goblin, `friend_${target.id}`, currentTick, 300)) {
      onLog?.(`\u{1F49B} became friends with ${target.name}`, "info");
    }
  }
};
var socialize = {
  name: "socialize",
  intentMatch: "socialize",
  eligible: ({ goblin, goblins: goblins2 }) => {
    if (goblin.social <= 30) return false;
    if (!goblins2) return false;
    const FRIEND_REL = 40;
    const FRIEND_RADIUS = traitMod(goblin, "generosityRange", 2) + 1;
    return goblins2.some(
      (other) => other.id !== goblin.id && other.alive && Math.abs(other.x - goblin.x) + Math.abs(other.y - goblin.y) <= FRIEND_RADIUS * 4 && (goblin.relations[other.id] ?? 50) >= FRIEND_REL
    );
  },
  score: ({ goblin }) => {
    const base = sigmoid(goblin.social, 50) * 0.6;
    const momentum = goblin.task.includes("socializing") ? 0.15 : 0;
    return Math.min(1, base + momentum);
  },
  execute: ({ goblin, goblins: goblins2, grid: grid2 }) => {
    if (!goblins2) {
      goblin.task = "lonely";
      return;
    }
    const FRIEND_REL = 40;
    const FRIEND_RADIUS = traitMod(goblin, "generosityRange", 2) + 1;
    let bestDist = Infinity;
    let bestFriend = null;
    for (const other of goblins2) {
      if (other.id === goblin.id || !other.alive) continue;
      if ((goblin.relations[other.id] ?? 50) < FRIEND_REL) continue;
      const dist = Math.abs(other.x - goblin.x) + Math.abs(other.y - goblin.y);
      if (dist > FRIEND_RADIUS * 4) continue;
      if (dist < bestDist) {
        bestDist = dist;
        bestFriend = other;
      }
    }
    if (!bestFriend) {
      goblin.task = "lonely";
      return;
    }
    if (bestDist > 1) {
      moveTo(goblin, { x: bestFriend.x, y: bestFriend.y }, grid2);
    }
    const closeDist = Math.abs(bestFriend.x - goblin.x) + Math.abs(bestFriend.y - goblin.y);
    if (closeDist <= FRIEND_RADIUS) {
      goblin.social = Math.max(0, goblin.social - 1.2);
    } else {
      goblin.social = Math.max(0, goblin.social - 0.4);
    }
    goblin.task = "socializing";
  }
};
var avoidRival = {
  name: "avoidRival",
  intentMatch: "avoid",
  eligible: ({ goblin, goblins: goblins2 }) => {
    if (!goblins2) return false;
    const avoidRadius = 3 + traitMod(goblin, "wariness", 2);
    return goblins2.some(
      (r) => r.alive && r.id !== goblin.id && Math.abs(r.x - goblin.x) + Math.abs(r.y - goblin.y) <= avoidRadius && (goblin.relations[r.id] ?? 50) < 30
    );
  },
  score: () => 0.3,
  execute: ({ goblin, goblins: goblins2, grid: grid2 }) => {
    if (!goblins2) return;
    const avoidRadius = 3 + traitMod(goblin, "wariness", 2);
    const rival = goblins2.filter((r) => r.alive && r.id !== goblin.id).map((r) => ({ r, dist: Math.abs(r.x - goblin.x) + Math.abs(r.y - goblin.y) })).filter((e) => e.dist <= avoidRadius && (goblin.relations[e.r.id] ?? 50) < 30).sort((a, b) => a.dist - b.dist)[0]?.r ?? null;
    if (!rival) return;
    const avoidDirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    const avoidOpen = avoidDirs.map((d) => ({ x: goblin.x + d.x, y: goblin.y + d.y })).filter((p) => isWalkable(grid2, p.x, p.y));
    if (avoidOpen.length > 0) {
      const next = avoidOpen.reduce(
        (best, p) => Math.abs(p.x - rival.x) + Math.abs(p.y - rival.y) > Math.abs(best.x - rival.x) + Math.abs(best.y - rival.y) ? p : best
      );
      goblin.x = next.x;
      goblin.y = next.y;
      goblin.task = `avoiding ${rival.name}`;
    }
  }
};

// src/simulation/actions/combat.ts
var fight = {
  name: "fight",
  intentMatch: void 0,
  eligible: ({ goblin, adventurers: adventurers2 }) => {
    if (!adventurers2 || adventurers2.length === 0) return false;
    const fleeAt = traitMod(goblin, "fleeThreshold", 80);
    return goblin.hunger < fleeAt;
  },
  score: ({ goblin, adventurers: adventurers2 }) => {
    if (!adventurers2 || adventurers2.length === 0) return 0;
    const HUNT_RADIUS = effectiveVision(goblin) * traitMod(goblin, "huntRange", 2);
    const nearest = adventurers2.reduce((best, g) => {
      const dist = Math.abs(g.x - goblin.x) + Math.abs(g.y - goblin.y);
      return !best || dist < best.dist ? { dist } : best;
    }, null);
    if (!nearest || nearest.dist > HUNT_RADIUS) return 0;
    return inverseSigmoid(nearest.dist, HUNT_RADIUS * 0.5, 0.2) * inverseSigmoid(goblin.hunger, 60) * ROLE_COMBAT_APT[goblin.role];
  },
  execute: ({ goblin, adventurers: adventurers2, grid: grid2, currentTick, onLog }) => {
    if (!adventurers2) return;
    const HUNT_RADIUS = effectiveVision(goblin) * traitMod(goblin, "huntRange", 2);
    const nearest = adventurers2.reduce((best, g) => {
      const dist = Math.abs(g.x - goblin.x) + Math.abs(g.y - goblin.y);
      return !best || dist < best.dist ? { g, dist } : best;
    }, null);
    if (!nearest || nearest.dist > HUNT_RADIUS) return;
    if (nearest.dist > 0) {
      if (!isLegWoundSkip(goblin)) {
        const step1 = pathNextStep({ x: goblin.x, y: goblin.y }, { x: nearest.g.x, y: nearest.g.y }, grid2);
        goblin.x = step1.x;
        goblin.y = step1.y;
      }
      if (!isLegWoundSkip(goblin)) {
        const step2 = pathNextStep({ x: goblin.x, y: goblin.y }, { x: nearest.g.x, y: nearest.g.y }, grid2);
        goblin.x = step2.x;
        goblin.y = step2.y;
      }
    }
    goblin.fatigue = Math.min(100, goblin.fatigue + 0.4 * fatigueRate(goblin));
    const distAfter = Math.abs(nearest.g.x - goblin.x) + Math.abs(nearest.g.y - goblin.y);
    const enemySing = getActiveFaction().enemyNounPlural.replace(/s$/, "");
    goblin.task = distAfter === 0 ? `fighting ${enemySing}!` : `\u2192 ${enemySing} (${distAfter} tiles)`;
    if (distAfter === 0) grantXp(goblin, currentTick, onLog);
  }
};
var seekSafety = {
  name: "seekSafety",
  intentMatch: "avoid",
  eligible: ({ goblin, dangerField: dangerField2 }) => {
    if (!dangerField2) return false;
    return getDanger(dangerField2, goblin.x, goblin.y) > 60;
  },
  score: ({ goblin, grid: grid2, dangerField: dangerField2 }) => {
    if (!dangerField2) return 0;
    const currentDanger = getDanger(dangerField2, goblin.x, goblin.y);
    if (currentDanger <= 60) return 0;
    let bestDanger = currentDanger;
    const SCAN = Math.min(5, effectiveVision(goblin));
    for (let dy = -SCAN; dy <= SCAN; dy++) {
      for (let dx = -SCAN; dx <= SCAN; dx++) {
        const nx = goblin.x + dx, ny = goblin.y + dy;
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
        if (!isWalkable(grid2, nx, ny)) continue;
        const d = getDanger(dangerField2, nx, ny);
        if (d < bestDanger) bestDanger = d;
      }
    }
    if (bestDanger >= currentDanger) return 0;
    return sigmoid(currentDanger, 60, 0.12) * 0.65;
  },
  execute: ({ goblin, grid: grid2, dangerField: dangerField2 }) => {
    if (!dangerField2) return;
    const SCAN = Math.min(5, effectiveVision(goblin));
    let bestDanger = getDanger(dangerField2, goblin.x, goblin.y);
    let bestTile = null;
    for (let dy = -SCAN; dy <= SCAN; dy++) {
      for (let dx = -SCAN; dx <= SCAN; dx++) {
        const nx = goblin.x + dx, ny = goblin.y + dy;
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
        if (!isWalkable(grid2, nx, ny)) continue;
        const d = getDanger(dangerField2, nx, ny);
        if (d < bestDanger) {
          bestDanger = d;
          bestTile = { x: nx, y: ny };
        }
      }
    }
    if (bestTile) {
      moveTo(goblin, bestTile, grid2);
      goblin.task = "fleeing to safety";
    }
  }
};

// src/simulation/actions/foraging.ts
var forage = {
  name: "forage",
  intentMatch: "forage",
  eligible: ({ goblin }) => totalLoad(goblin.inventory) < MAX_INVENTORY_CAPACITY,
  score: ({ goblin, grid: grid2 }) => {
    const vision = effectiveVision(goblin);
    const maxSearch = traitMod(goblin, "maxSearchRadius", 15);
    const radius = goblin.hunger > 20 ? maxSearch : Math.round(Math.min(vision * (1 + sigmoid(goblin.hunger, 60) * 0.8), maxSearch));
    const target = bestFoodTile(goblin, grid2, radius);
    if (!target) {
      if (goblin.knownFoodSites.length > 0) return sigmoid(goblin.hunger, 40) * 0.4;
      return 0;
    }
    const base = sigmoid(goblin.hunger, 40) * 0.8;
    const momentum = goblin.task.includes("foraging") || goblin.task.includes("harvesting") || goblin.task.includes("remembered") ? 0.15 : 0;
    const score = Math.min(1, base + momentum);
    return goblin.hunger > 85 ? score * 0.4 : score;
  },
  execute: (ctx) => {
    const { goblin, grid: grid2, currentTick, goblins: goblins2, onLog } = ctx;
    const vision = effectiveVision(goblin);
    const maxSearch = traitMod(goblin, "maxSearchRadius", 15);
    const radius = goblin.llmIntent === "forage" || goblin.hunger > 20 ? maxSearch : Math.round(Math.min(vision * (1 + sigmoid(goblin.hunger, 60) * 0.8), maxSearch));
    const foodTarget = bestFoodTile(goblin, grid2, radius);
    if (foodTarget) {
      const tv = grid2[foodTarget.y][foodTarget.x].foodValue;
      if (tv >= SITE_RECORD_THRESHOLD) {
        recordSite(goblin.knownFoodSites, foodTarget.x, foodTarget.y, tv, currentTick);
      }
    }
    if (foodTarget) {
      if (goblin.x !== foodTarget.x || goblin.y !== foodTarget.y) {
        moveTo(goblin, foodTarget, grid2);
      }
      const here = grid2[goblin.y][goblin.x];
      if (goblins2) {
        const contestPriority = (g) => g.hunger + g.skillLevel * 5;
        const rival = goblins2.find(
          (d) => d.alive && d.id !== goblin.id && d.x === goblin.x && d.y === goblin.y && contestPriority(d) > contestPriority(goblin)
        );
        if (rival) {
          const relation = goblin.relations[rival.id] ?? 50;
          if (relation >= 60) {
            goblin.relations[rival.id] = Math.min(100, relation + 2);
            goblin.task = `sharing tile with ${rival.name}`;
            return;
          }
          const penalty = traitMod(goblin, "contestPenalty", -5);
          const newRel = Math.max(0, relation + penalty);
          goblin.relations[rival.id] = newRel;
          if (relation >= 20 && newRel < 20 && shouldLog(goblin, `rival_${rival.id}`, currentTick, 300)) {
            onLog?.(`\u{1F4A2} growing rivalry with ${rival.name}`, "warn");
          }
          const escapeDirs = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
          const escapeOpen = escapeDirs.map((d) => ({ x: goblin.x + d.dx, y: goblin.y + d.dy })).filter((p) => isWalkable(grid2, p.x, p.y));
          if (escapeOpen.length > 0) {
            const step = escapeOpen[Math.floor(Math.random() * escapeOpen.length)];
            goblin.x = step.x;
            goblin.y = step.y;
          }
          goblin.task = `yielding to ${rival.name}`;
          return;
        }
      }
      const headroom = MAX_INVENTORY_CAPACITY - totalLoad(goblin.inventory);
      if (FORAGEABLE_TILES.has(here.type) && here.foodValue >= 1) {
        const roleBonus = goblin.role === "forager" ? 1 : 0;
        const gatherBonus = roleBonus + traitMod(goblin, "gatheringPower", 0);
        const depletionRate = 5 + gatherBonus;
        const baseYield = 1 + gatherBonus + skillYieldBonus(goblin);
        const moraleScale = 0.5 + goblin.morale / 100 * 0.5;
        const fatigueScale = 1 - inverseSigmoid(goblin.fatigue, 70, 0.12) * 0.5;
        const woundScale = woundYieldMultiplier(goblin);
        const harvestYield = Math.max(1, Math.round(baseYield * moraleScale * fatigueScale * woundScale));
        const hadFood = here.foodValue;
        const depleted = Math.min(hadFood, depletionRate);
        here.foodValue = Math.max(0, hadFood - depleted);
        if (here.foodValue === 0) {
          here.type = "dirt" /* Dirt */;
          here.maxFood = 0;
        }
        const amount = Math.min(harvestYield, depleted, headroom);
        goblin.inventory.food += amount;
        addWorkFatigue(goblin);
        if (goblin.role === "forager") grantXp(goblin, currentTick, onLog);
        goblin.task = `harvesting (food: ${goblin.inventory.food.toFixed(0)})`;
      } else {
        goblin.task = `foraging \u2192 (${foodTarget.x},${foodTarget.y})`;
      }
      return;
    }
    if (goblin.knownFoodSites.length > 0) {
      const best = goblin.knownFoodSites.reduce((a, b) => b.value > a.value ? b : a);
      if (goblin.x === best.x && goblin.y === best.y) {
        const tileHere = grid2[goblin.y][goblin.x];
        const stillGood = tileHere.foodValue >= 1 && FORAGEABLE_TILES.has(tileHere.type);
        if (!stillGood) {
          let better = null;
          for (let dy = -PATCH_MERGE_RADIUS; dy <= PATCH_MERGE_RADIUS; dy++) {
            for (let dx = -PATCH_MERGE_RADIUS; dx <= PATCH_MERGE_RADIUS; dx++) {
              const nx = best.x + dx, ny = best.y + dy;
              if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
              const t = grid2[ny][nx];
              if (!FORAGEABLE_TILES.has(t.type) || t.foodValue < 1) continue;
              if (!better || t.foodValue > better.value) {
                better = { x: nx, y: ny, value: t.foodValue, tick: currentTick };
              }
            }
          }
          if (better) {
            goblin.knownFoodSites = goblin.knownFoodSites.map(
              (s) => s.x === best.x && s.y === best.y ? better : s
            );
          } else {
            goblin.knownFoodSites = goblin.knownFoodSites.filter(
              (s) => !(s.x === best.x && s.y === best.y)
            );
          }
        } else {
          recordSite(goblin.knownFoodSites, best.x, best.y, tileHere.foodValue, currentTick);
        }
      } else {
        moveTo(goblin, best, grid2);
        goblin.task = "\u2192 remembered patch";
      }
    }
  }
};
var DEPOSIT_KEEP_FOOD = 6;
var depositFood = {
  name: "depositFood",
  eligible: ({ goblin, foodStockpiles: foodStockpiles2 }) => {
    if (goblin.inventory.food <= 0) return false;
    return nearestFoodStockpile(goblin, foodStockpiles2, (s) => s.food < s.maxFood) !== null;
  },
  score: ({ goblin, foodStockpiles: foodStockpiles2 }) => {
    const onStockpile = foodStockpiles2?.some((s) => s.x === goblin.x && s.y === goblin.y) ?? false;
    return ramp(goblin.inventory.food, 6, 20) * inverseSigmoid(goblin.hunger, 50) * 0.6 * (onStockpile ? 2.5 : 1);
  },
  execute: ({ goblin, grid: grid2, foodStockpiles: foodStockpiles2 }) => {
    const target = nearestFoodStockpile(goblin, foodStockpiles2, (s) => s.food < s.maxFood);
    if (!target) return;
    if (goblin.x === target.x && goblin.y === target.y) {
      const amount = goblin.inventory.food - DEPOSIT_KEEP_FOOD;
      const stored = Math.min(amount, target.maxFood - target.food);
      if (stored > 0) {
        target.food += stored;
        goblin.inventory.food -= stored;
        goblin.task = `deposited ${stored.toFixed(0)} \u2192 stockpile`;
      }
    } else {
      moveTo(goblin, target, grid2);
      goblin.task = "\u2192 home (deposit)";
    }
  }
};
var withdrawFood = {
  name: "withdrawFood",
  eligible: ({ goblin, foodStockpiles: foodStockpiles2 }) => {
    if (goblin.inventory.food >= 4 || goblin.inventory.meals >= 4) return false;
    return nearestFoodStockpile(goblin, foodStockpiles2, (s) => s.food > 0 || s.meals > 0) !== null;
  },
  score: ({ goblin, foodStockpiles: foodStockpiles2 }) => {
    const onStockpile = foodStockpiles2?.some((s) => s.x === goblin.x && s.y === goblin.y) ?? false;
    return sigmoid(goblin.hunger, 45) * 0.75 * (onStockpile ? 2.5 : 1);
  },
  execute: ({ goblin, grid: grid2, foodStockpiles: foodStockpiles2 }) => {
    const target = nearestFoodStockpile(goblin, foodStockpiles2, (s) => s.food > 0 || s.meals > 0);
    if (!target) return;
    if (goblin.x === target.x && goblin.y === target.y) {
      if (target.meals > 0) {
        const amount = Math.min(4, target.meals);
        target.meals -= amount;
        goblin.inventory.meals += Math.min(amount, MAX_INVENTORY_CAPACITY - totalLoad(goblin.inventory));
        goblin.task = `withdrew ${amount.toFixed(0)} meals`;
      } else {
        const amount = Math.min(4, target.food);
        target.food -= amount;
        goblin.inventory.food += Math.min(amount, MAX_INVENTORY_CAPACITY - totalLoad(goblin.inventory));
        goblin.task = `withdrew ${amount.toFixed(0)} food`;
      }
    } else {
      moveTo(goblin, target, grid2);
      goblin.task = `\u2192 stockpile (${target.meals.toFixed(0)} meals, ${target.food.toFixed(0)} food)`;
    }
  }
};

// src/simulation/actions/materials.ts
var mine = {
  name: "mine",
  eligible: ({ goblin }) => totalLoad(goblin.inventory) < MAX_INVENTORY_CAPACITY,
  score: ({ goblin, grid: grid2, oreStockpiles: oreStockpiles2 }) => {
    const apt = ROLE_MINING_APT[goblin.role];
    const totalOre = oreStockpiles2?.reduce((s, p) => s + p.ore, 0) ?? 0;
    const maxOre = oreStockpiles2?.reduce((s, p) => s + p.maxOre, 0) ?? 1;
    const oreNeed = maxOre > 0 ? 0.2 + 0.8 * (1 - totalOre / maxOre) : 1;
    if ((goblin.warmth ?? 100) < 15 && !goblin.task.includes("warming")) return 0;
    const radius = Math.max(effectiveVision(goblin), traitMod(goblin, "maxSearchRadius", 15));
    const target = bestMaterialTile(goblin, grid2, radius);
    if (!target) {
      if (goblin.knownOreSites.length > 0) return inverseSigmoid(goblin.hunger, 60) * 0.35 * apt * oreNeed;
      return 0;
    }
    const base = inverseSigmoid(goblin.hunger, 60) * 0.6 * apt * oreNeed;
    const momentum = goblin.task.includes("mining") || goblin.task.includes("remembered ore") ? 0.15 : 0;
    return Math.min(1, base + momentum);
  },
  execute: (ctx) => {
    const { goblin, grid: grid2, currentTick, onLog } = ctx;
    const radius = Math.max(effectiveVision(goblin), traitMod(goblin, "maxSearchRadius", 15));
    const oreTarget = bestMaterialTile(goblin, grid2, radius);
    if (oreTarget) {
      const mv = grid2[oreTarget.y][oreTarget.x].materialValue;
      if (mv >= SITE_RECORD_THRESHOLD) {
        recordSite(goblin.knownOreSites, oreTarget.x, oreTarget.y, mv, currentTick);
      }
    }
    if (oreTarget) {
      if (goblin.x === oreTarget.x && goblin.y === oreTarget.y) {
        const here = grid2[goblin.y][goblin.x];
        if (here.type === "ore" /* Ore */ && here.materialValue >= 1) {
          const hadMat = here.materialValue;
          const baseOre = 2 + skillOreBonus(goblin);
          const oreYield = Math.max(1, Math.round(baseOre * woundYieldMultiplier(goblin)));
          const mined = Math.min(hadMat, oreYield);
          here.materialValue = Math.max(0, hadMat - mined);
          if (here.materialValue === 0) {
            here.type = "stone" /* Stone */;
            here.maxMaterial = 0;
          }
          goblin.inventory.ore += Math.min(mined, MAX_INVENTORY_CAPACITY - totalLoad(goblin.inventory));
          addWorkFatigue(goblin);
          grantXp(goblin, currentTick, onLog);
          goblin.task = `mining (ore: ${here.materialValue.toFixed(0)})`;
        } else {
          goblin.task = "mining\u2026 looking for vein";
        }
      } else {
        moveTo(goblin, oreTarget, grid2);
        goblin.task = `mining \u2192 (${oreTarget.x},${oreTarget.y})`;
      }
      return;
    }
    if (goblin.knownOreSites.length > 0) {
      const best = goblin.knownOreSites.reduce((a, b) => b.value > a.value ? b : a);
      if (goblin.x === best.x && goblin.y === best.y) {
        const tileHere = grid2[goblin.y][goblin.x];
        if (tileHere.type !== "ore" /* Ore */ || tileHere.materialValue < 1) {
          goblin.knownOreSites = goblin.knownOreSites.filter((s) => !(s.x === best.x && s.y === best.y));
          goblin.task = "searching for ore\u2026";
        } else {
          recordSite(goblin.knownOreSites, best.x, best.y, tileHere.materialValue, currentTick);
          goblin.task = "preparing to mine\u2026";
        }
      } else {
        moveTo(goblin, best, grid2);
        goblin.task = `\u2192 remembered ore (${best.x},${best.y})`;
      }
    }
  }
};
var chop = {
  name: "chop",
  eligible: ({ goblin }) => totalLoad(goblin.inventory) < MAX_INVENTORY_CAPACITY,
  score: ({ goblin, grid: grid2, woodStockpiles: woodStockpiles2 }) => {
    const apt = ROLE_CHOP_APT[goblin.role];
    const totalWood = woodStockpiles2?.reduce((s, p) => s + p.wood, 0) ?? 0;
    const maxWood = woodStockpiles2?.reduce((s, p) => s + p.maxWood, 0) ?? 1;
    const woodNeed = maxWood > 0 ? 0.2 + 0.8 * (1 - totalWood / maxWood) : 1;
    if ((goblin.warmth ?? 100) < 15 && !goblin.task.includes("warming")) return 0;
    const radius = Math.max(effectiveVision(goblin), traitMod(goblin, "maxSearchRadius", 15));
    const target = bestWoodTile(goblin, grid2, radius);
    if (!target) {
      if (goblin.knownWoodSites.length > 0) return inverseSigmoid(goblin.hunger, 60) * 0.35 * apt * woodNeed;
      return 0;
    }
    const base = inverseSigmoid(goblin.hunger, 60) * 0.6 * apt * woodNeed;
    const momentum = goblin.task.includes("logging") || goblin.task.includes("forest") || goblin.task.includes("remembered forest") ? 0.15 : 0;
    return Math.min(1, base + momentum);
  },
  execute: (ctx) => {
    const { goblin, grid: grid2, currentTick, onLog } = ctx;
    const radius = Math.max(effectiveVision(goblin), traitMod(goblin, "maxSearchRadius", 15));
    const woodTarget = bestWoodTile(goblin, grid2, radius);
    if (woodTarget) {
      const mv = grid2[woodTarget.y][woodTarget.x].materialValue;
      if (mv >= SITE_RECORD_THRESHOLD) {
        recordSite(goblin.knownWoodSites, woodTarget.x, woodTarget.y, mv, currentTick);
      }
    }
    if (woodTarget) {
      if (goblin.x === woodTarget.x && goblin.y === woodTarget.y) {
        const here = grid2[goblin.y][goblin.x];
        if (here.type === "forest" /* Forest */ && here.materialValue >= 1) {
          const hadWood = here.materialValue;
          const roleChopBonus = goblin.role === "lumberjack" ? 15 : 0;
          const baseChop = 5 + roleChopBonus + traitMod(goblin, "chopPower", 0) + skillYieldBonus(goblin);
          const chopYield = Math.max(1, Math.round(baseChop * woundYieldMultiplier(goblin)));
          const chopped = Math.min(hadWood, chopYield);
          here.materialValue = Math.max(0, hadWood - chopped);
          if (here.materialValue === 0) {
            here.type = "treestump" /* TreeStump */;
            here.maxMaterial = 0;
          }
          goblin.inventory.wood += Math.min(chopped, MAX_INVENTORY_CAPACITY - totalLoad(goblin.inventory));
          addWorkFatigue(goblin);
          grantXp(goblin, currentTick, onLog);
          goblin.task = `logging (wood: ${here.materialValue.toFixed(0)})`;
        } else {
          goblin.task = "logging\u2026 looking for tree";
        }
      } else {
        moveTo(goblin, woodTarget, grid2);
        goblin.task = `logging \u2192 (${woodTarget.x},${woodTarget.y})`;
      }
      return;
    }
    if (goblin.knownWoodSites.length > 0) {
      const best = goblin.knownWoodSites.reduce((a, b) => b.value > a.value ? b : a);
      if (goblin.x === best.x && goblin.y === best.y) {
        const tileHere = grid2[goblin.y][goblin.x];
        if (tileHere.type !== "forest" /* Forest */ || tileHere.materialValue < 1) {
          goblin.knownWoodSites = goblin.knownWoodSites.filter((s) => !(s.x === best.x && s.y === best.y));
          goblin.task = "searching for forest\u2026";
        } else {
          recordSite(goblin.knownWoodSites, best.x, best.y, tileHere.materialValue, currentTick);
          goblin.task = "preparing to log\u2026";
        }
      } else {
        moveTo(goblin, best, grid2);
        goblin.task = `\u2192 remembered forest (${best.x},${best.y})`;
      }
    }
  }
};
var depositOre = {
  name: "depositOre",
  eligible: ({ goblin, oreStockpiles: oreStockpiles2 }) => {
    if (goblin.inventory.ore <= 0) return false;
    return nearestOreStockpile(goblin, oreStockpiles2, (s) => s.ore < s.maxOre) !== null;
  },
  score: ({ goblin, oreStockpiles: oreStockpiles2 }) => {
    const onStockpile = oreStockpiles2?.some((s) => s.x === goblin.x && s.y === goblin.y) ?? false;
    return ramp(goblin.inventory.ore, 6, 20) * 0.5 * (onStockpile ? 2.5 : 1);
  },
  execute: ({ goblin, grid: grid2, oreStockpiles: oreStockpiles2 }) => {
    const target = nearestOreStockpile(goblin, oreStockpiles2, (s) => s.ore < s.maxOre);
    if (!target) return;
    if (goblin.x === target.x && goblin.y === target.y) {
      const stored = Math.min(goblin.inventory.ore, target.maxOre - target.ore);
      if (stored > 0) {
        target.ore += stored;
        goblin.inventory.ore -= stored;
        goblin.task = `deposited ${stored.toFixed(0)} ore \u2192 stockpile`;
      }
    } else {
      moveTo(goblin, target, grid2);
      goblin.task = `\u2192 ore stockpile (${goblin.inventory.ore.toFixed(0)} ore)`;
    }
  }
};
var depositWood = {
  name: "depositWood",
  eligible: ({ goblin, woodStockpiles: woodStockpiles2 }) => {
    if (goblin.inventory.wood <= 0) return false;
    return nearestWoodStockpile(goblin, woodStockpiles2, (s) => s.wood < s.maxWood) !== null;
  },
  score: ({ goblin, woodStockpiles: woodStockpiles2 }) => {
    const onStockpile = woodStockpiles2?.some((s) => s.x === goblin.x && s.y === goblin.y) ?? false;
    return ramp(goblin.inventory.wood, 6, 20) * 0.5 * (onStockpile ? 2.5 : 1);
  },
  execute: ({ goblin, grid: grid2, woodStockpiles: woodStockpiles2 }) => {
    const target = nearestWoodStockpile(goblin, woodStockpiles2, (s) => s.wood < s.maxWood);
    if (!target) return;
    if (goblin.x === target.x && goblin.y === target.y) {
      const stored = Math.min(goblin.inventory.wood, target.maxWood - target.wood);
      if (stored > 0) {
        target.wood += stored;
        goblin.inventory.wood -= stored;
        goblin.task = `deposited ${stored.toFixed(0)} wood \u2192 stockpile`;
      }
    } else {
      moveTo(goblin, target, grid2);
      goblin.task = `\u2192 wood stockpile (${goblin.inventory.wood.toFixed(0)} wood)`;
    }
  }
};

// src/simulation/actions/building.ts
var buildWall = {
  name: "buildWall",
  eligible: ({ rooms: rooms2, oreStockpiles: oreStockpiles2, goblin }) => {
    if (!rooms2 || rooms2.length === 0) return false;
    const stockpileOre = oreStockpiles2?.reduce((s, o) => s + o.ore, 0) ?? 0;
    return stockpileOre >= 3 || goblin.inventory.ore >= 3;
  },
  score: ({ goblin, oreStockpiles: oreStockpiles2, rooms: rooms2, grid: grid2, goblins: goblins2, adventurers: adventurers2 }) => {
    const totalOre = (oreStockpiles2?.reduce((s, o) => s + o.ore, 0) ?? 0) + goblin.inventory.ore;
    if (totalOre < 3) return 0;
    if (!rooms2 || rooms2.length === 0) return 0;
    const wallSlots = roomWallSlots(rooms2, grid2, goblins2, goblin.id, adventurers2);
    if (wallSlots.length === 0) return 0;
    const base = ramp(totalOre, 3, 30) * inverseSigmoid(goblin.hunger, 50) * 0.45;
    const momentum = goblin.task.includes("wall") ? 0.15 : 0;
    return Math.min(1, base + momentum);
  },
  execute: ({ goblin, grid: grid2, rooms: rooms2, oreStockpiles: oreStockpiles2, goblins: goblins2, adventurers: adventurers2 }) => {
    if (!rooms2 || rooms2.length === 0) return;
    const buildStockpile = oreStockpiles2?.find((s) => s.ore >= 3);
    const useInventory = !buildStockpile && goblin.inventory.ore >= 3;
    if (!buildStockpile && !useInventory) return;
    const wallSlots = roomWallSlots(rooms2, grid2, goblins2, goblin.id, adventurers2);
    let nearestSlot = null;
    let nearestDist = Infinity;
    for (const s of wallSlots) {
      const dist = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
      if (dist > 0 && dist < nearestDist) {
        nearestDist = dist;
        nearestSlot = s;
      }
    }
    if (nearestSlot) {
      const next = pathNextStep({ x: goblin.x, y: goblin.y }, nearestSlot, grid2);
      if (next.x === nearestSlot.x && next.y === nearestSlot.y) {
        const t = grid2[nearestSlot.y][nearestSlot.x];
        grid2[nearestSlot.y][nearestSlot.x] = {
          ...t,
          type: "wall" /* Wall */,
          foodValue: 0,
          maxFood: 0,
          materialValue: 0,
          maxMaterial: 0,
          growbackRate: 0
        };
        if (buildStockpile) {
          buildStockpile.ore -= 3;
        } else {
          goblin.inventory.ore -= 3;
        }
        addWorkFatigue(goblin);
        goblin.task = "built room wall!";
      } else {
        goblin.x = next.x;
        goblin.y = next.y;
        goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate(goblin));
        goblin.task = "\u2192 room wall";
      }
    }
  }
};
var HEARTH_COVERAGE_RADIUS = 8;
var HEARTH_BUILD_COOLDOWN = 300;
var buildHearth = {
  name: "buildHearth",
  eligible: ({ goblin, woodStockpiles: woodStockpiles2, foodStockpiles: foodStockpiles2, grid: grid2, currentTick }) => {
    const totalFood = foodStockpiles2?.reduce((s, f) => s + f.food, 0) ?? 0;
    if (totalFood < 20) return false;
    const totalWood = woodStockpiles2?.reduce((s, w) => s + w.wood, 0) ?? 0;
    if (totalWood < 2) return false;
    if (currentTick - (goblin.lastLoggedTicks["builtHearth"] ?? 0) < HEARTH_BUILD_COOLDOWN) return false;
    for (let dy = -HEARTH_COVERAGE_RADIUS; dy <= HEARTH_COVERAGE_RADIUS; dy++) {
      for (let dx = -HEARTH_COVERAGE_RADIUS; dx <= HEARTH_COVERAGE_RADIUS; dx++) {
        const nx = goblin.x + dx, ny = goblin.y + dy;
        if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE && grid2[ny][nx].type === "hearth" /* Hearth */) return false;
      }
    }
    return true;
  },
  score: ({ goblin, woodStockpiles: woodStockpiles2 }) => {
    const totalWood = woodStockpiles2?.reduce((s, w) => s + w.wood, 0) ?? 0;
    const warmth = goblin.warmth ?? 100;
    const base = inverseSigmoid(warmth, 25, 0.12) * ramp(totalWood, 2, 20) * inverseSigmoid(goblin.hunger, 60) * 0.5;
    const momentum = goblin.task.includes("hearth") && base > 0 ? 0.15 : 0;
    return Math.min(1, base + momentum);
  },
  execute: ({ goblin, grid: grid2, woodStockpiles: woodStockpiles2, currentTick, onLog }) => {
    if (!woodStockpiles2) return;
    const buildStockpile = nearestWoodStockpile(goblin, woodStockpiles2, (s) => s.wood >= 2);
    if (!buildStockpile) return;
    let buildTarget = null;
    let bestScore = Infinity;
    const RADIUS = 5;
    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        const nx = goblin.x + dx, ny = goblin.y + dy;
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
        const t2 = grid2[ny][nx];
        if (t2.type !== "dirt" /* Dirt */ && t2.type !== "grass" /* Grass */) continue;
        const distToGoblin = Math.abs(dx) + Math.abs(dy);
        const distToHome = Math.abs(nx - goblin.homeTile.x) + Math.abs(ny - goblin.homeTile.y);
        const siteScore = distToGoblin + 0.2 * distToHome;
        if (siteScore < bestScore) {
          bestScore = siteScore;
          buildTarget = { x: nx, y: ny };
        }
      }
    }
    if (!buildTarget) return;
    if (goblin.x !== buildTarget.x || goblin.y !== buildTarget.y) {
      moveTo(goblin, buildTarget, grid2);
      goblin.task = "\u2192 hearth site";
      return;
    }
    const t = grid2[buildTarget.y][buildTarget.x];
    grid2[buildTarget.y][buildTarget.x] = {
      ...t,
      type: "hearth" /* Hearth */,
      foodValue: 0,
      maxFood: 0,
      materialValue: 0,
      maxMaterial: 0,
      growbackRate: 0
    };
    buildStockpile.wood -= 2;
    addWorkFatigue(goblin);
    goblin.lastLoggedTicks["builtHearth"] = currentTick;
    recordSite(goblin.knownHearthSites ?? (goblin.knownHearthSites = []), buildTarget.x, buildTarget.y, 1, currentTick);
    goblin.task = "built a hearth!";
    if (shouldLog(goblin, "buildHearth", currentTick, 300)) {
      onLog?.("\u{1F525} built a hearth for warmth", "info");
    }
  }
};

// src/simulation/actions/exploration.ts
var wander = {
  name: "wander",
  eligible: () => true,
  score: () => 0.05,
  execute: ({ goblin, grid: grid2, currentTick, onLog }) => {
    const WANDER_HOLD_TICKS = 25;
    const wanDrift = traitMod(goblin, "wariness", 2);
    const WANDER_MIN_DIST = 8 + wanDrift;
    const WANDER_MAX_DIST = 16 + wanDrift * 2;
    if (goblin.wanderTarget && !isWalkable(grid2, goblin.wanderTarget.x, goblin.wanderTarget.y)) {
      goblin.wanderTarget = null;
    }
    if (goblin.wanderTarget && goblin.x === goblin.wanderTarget.x && goblin.y === goblin.wanderTarget.y) {
      if (goblin.role === "scout") grantXp(goblin, currentTick, onLog);
    }
    if (!goblin.wanderTarget || currentTick >= goblin.wanderExpiry || goblin.x === goblin.wanderTarget.x && goblin.y === goblin.wanderTarget.y) {
      let picked = false;
      const homeDrift = traitMod(goblin, "wanderHomeDrift", 0.25);
      if (Math.random() < homeDrift && (goblin.homeTile.x !== 0 || goblin.homeTile.y !== 0)) {
        const hx = goblin.homeTile.x + Math.round((Math.random() - 0.5) * 20);
        const hy = goblin.homeTile.y + Math.round((Math.random() - 0.5) * 20);
        if (hx >= 0 && hx < GRID_SIZE && hy >= 0 && hy < GRID_SIZE && isWalkable(grid2, hx, hy)) {
          goblin.wanderTarget = { x: hx, y: hy };
          goblin.wanderExpiry = currentTick + WANDER_HOLD_TICKS;
          picked = true;
        }
      }
      if (!picked) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const angle = Math.random() * Math.PI * 2;
          const dist = WANDER_MIN_DIST + Math.random() * (WANDER_MAX_DIST - WANDER_MIN_DIST);
          const wx = Math.round(goblin.x + Math.cos(angle) * dist);
          const wy = Math.round(goblin.y + Math.sin(angle) * dist);
          if (wx >= 0 && wx < GRID_SIZE && wy >= 0 && wy < GRID_SIZE && isWalkable(grid2, wx, wy)) {
            goblin.wanderTarget = { x: wx, y: wy };
            goblin.wanderExpiry = currentTick + WANDER_HOLD_TICKS;
            picked = true;
            break;
          }
        }
      }
      if (!picked) {
        const fallDirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
        const fallOpen = fallDirs.map((d) => ({ x: goblin.x + d.x, y: goblin.y + d.y })).filter((p) => isWalkable(grid2, p.x, p.y));
        if (fallOpen.length > 0) {
          const fb = fallOpen[Math.floor(Math.random() * fallOpen.length)];
          goblin.x = fb.x;
          goblin.y = fb.y;
        }
        goblin.task = "wandering";
        return;
      }
    }
    moveTo(goblin, goblin.wanderTarget, grid2);
    goblin.task = "exploring";
  }
};
var SEEK_WARMTH_RADIUS = 15;
var SEEK_WARMTH_COOLDOWN = 150;
var SEEK_WARMTH_SCORE_COLD = 0.28;
var SEEK_WARMTH_SCORE_DEFAULT = 0.08;
var seekWarmth = {
  name: "seekWarmth",
  intentMatch: "rest",
  eligible: ({ goblin, warmthField: warmthField2, grid: grid2, currentTick }) => {
    if (!warmthField2) return false;
    const warmth = goblin.warmth ?? 100;
    const exitThreshold = goblin.task === "seeking warmth" ? 50 : 25;
    if (warmth >= exitThreshold) return false;
    if (currentTick - (goblin.lastLoggedTicks["seekWarmthDone"] ?? 0) < SEEK_WARMTH_COOLDOWN) return false;
    for (let dy = -SEEK_WARMTH_RADIUS; dy <= SEEK_WARMTH_RADIUS; dy++) {
      for (let dx = -SEEK_WARMTH_RADIUS; dx <= SEEK_WARMTH_RADIUS; dx++) {
        const nx = goblin.x + dx, ny = goblin.y + dy;
        if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE && grid2[ny][nx].type === "hearth" /* Hearth */) return true;
      }
    }
    return (goblin.knownHearthSites ?? []).length > 0;
  },
  score: ({ goblin, grid: grid2, warmthField: warmthField2, weatherType }) => {
    if (!warmthField2) return 0;
    let hearthExists = (goblin.knownHearthSites ?? []).length > 0;
    if (!hearthExists) {
      for (let dy = -SEEK_WARMTH_RADIUS; dy <= SEEK_WARMTH_RADIUS; dy++) {
        for (let dx = -SEEK_WARMTH_RADIUS; dx <= SEEK_WARMTH_RADIUS; dx++) {
          const nx = goblin.x + dx, ny = goblin.y + dy;
          if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE && grid2[ny][nx].type === "hearth" /* Hearth */) {
            hearthExists = true;
            break;
          }
        }
        if (hearthExists) break;
      }
    }
    if (!hearthExists) return 0;
    const warmth = goblin.warmth ?? 100;
    const maxScore = weatherType === "cold" ? SEEK_WARMTH_SCORE_COLD : SEEK_WARMTH_SCORE_DEFAULT;
    return inverseSigmoid(warmth, 20, 0.12) * maxScore;
  },
  execute: ({ goblin, grid: grid2, currentTick }) => {
    let nearestHearth = null;
    let nearestDist = Infinity;
    for (let dy = -SEEK_WARMTH_RADIUS; dy <= SEEK_WARMTH_RADIUS; dy++) {
      for (let dx = -SEEK_WARMTH_RADIUS; dx <= SEEK_WARMTH_RADIUS; dx++) {
        const nx = goblin.x + dx, ny = goblin.y + dy;
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
        if (grid2[ny][nx].type !== "hearth" /* Hearth */) continue;
        recordSite(goblin.knownHearthSites ?? (goblin.knownHearthSites = []), nx, ny, 1, currentTick);
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestHearth = { x: nx, y: ny };
        }
      }
    }
    if (!nearestHearth) {
      const sites = goblin.knownHearthSites ?? [];
      const sorted2 = [...sites].sort(
        (a, b) => Math.abs(a.x - goblin.x) + Math.abs(a.y - goblin.y) - (Math.abs(b.x - goblin.x) + Math.abs(b.y - goblin.y))
      );
      for (const site of sorted2) {
        if (grid2[site.y]?.[site.x]?.type === "hearth" /* Hearth */) {
          nearestHearth = { x: site.x, y: site.y };
          nearestDist = Math.abs(site.x - goblin.x) + Math.abs(site.y - goblin.y);
          break;
        }
        goblin.knownHearthSites = sites.filter((s) => !(s.x === site.x && s.y === site.y));
      }
    }
    if (!nearestHearth) return;
    const warmth = goblin.warmth ?? 0;
    if (nearestDist <= traitMod(goblin, "coziness", 2) || warmth >= 40) {
      goblin.lastLoggedTicks["seekWarmthDone"] = currentTick;
      goblin.task = "warming up";
      return;
    }
    moveTo(goblin, nearestHearth, grid2);
    goblin.task = "seeking warmth";
  }
};

// src/simulation/actions/firefighting.ts
var FIRE_SCAN_RADIUS = 18;
var WATER_SCAN_RADIUS = 24;
var DOUSE_CHANCE = 0.8;
var SINGE_CHANCE = 0.2;
var SINGE_MOR_LOSS = 5;
function nearestFire(cx, cy, grid2, radius) {
  let best = null;
  let bestDist = Infinity;
  const x0 = Math.max(0, cx - radius), x1 = Math.min(GRID_SIZE - 1, cx + radius);
  const y0 = Math.max(0, cy - radius), y1 = Math.min(GRID_SIZE - 1, cy + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (grid2[y][x].type !== "fire" /* Fire */) continue;
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d < bestDist) {
        bestDist = d;
        best = { x, y };
      }
    }
  }
  return best;
}
var WATER_SOURCES = /* @__PURE__ */ new Set(["water" /* Water */, "pool" /* Pool */]);
function nearestWater(cx, cy, grid2, radius) {
  let best = null;
  let bestDist = Infinity;
  const x0 = Math.max(0, cx - radius), x1 = Math.min(GRID_SIZE - 1, cx + radius);
  const y0 = Math.max(0, cy - radius), y1 = Math.min(GRID_SIZE - 1, cy + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!WATER_SOURCES.has(grid2[y][x].type)) continue;
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d < bestDist) {
        bestDist = d;
        best = { x, y };
      }
    }
  }
  return best;
}
var fightFire = {
  name: "fightFire",
  eligible({ goblin, grid: grid2 }) {
    return nearestFire(goblin.x, goblin.y, grid2, FIRE_SCAN_RADIUS) !== null;
  },
  score({ goblin, grid: grid2 }) {
    const fire = nearestFire(goblin.x, goblin.y, grid2, FIRE_SCAN_RADIUS);
    if (!fire) return 0;
    const dist = Math.abs(fire.x - goblin.x) + Math.abs(fire.y - goblin.y);
    const vision = effectiveVision(goblin);
    const base = 0.8 * inverseSigmoid(dist, vision, 0.2);
    const active = goblin.task.includes("fire") || goblin.task.includes("water") || goblin.carryingWater;
    const momentum = active ? 0.15 : 0;
    return Math.min(1, base + momentum);
  },
  execute({ goblin, grid: grid2, currentTick, onLog }) {
    if (!goblin.carryingWater) {
      const water = nearestWater(goblin.x, goblin.y, grid2, WATER_SCAN_RADIUS);
      if (!water) {
        goblin.carryingWater = false;
        goblin.task = "looking for water (no lake?)";
        return;
      }
      const dist = Math.abs(water.x - goblin.x) + Math.abs(water.y - goblin.y);
      if (dist <= 1) {
        goblin.carryingWater = true;
        goblin.task = "\u{1F4A7} filled bucket";
        if (shouldLog(goblin, "fillBucket", currentTick, 60)) {
          onLog?.(`\u{1F4A7} ${goblin.name} filled a bucket from the lake`, "info");
        }
      } else {
        moveTo(goblin, water, grid2);
        goblin.task = `\u2192 water (${dist} tiles)`;
      }
    } else {
      const fire = nearestFire(goblin.x, goblin.y, grid2, FIRE_SCAN_RADIUS);
      if (!fire) {
        goblin.carryingWater = false;
        goblin.task = "fire already out";
        return;
      }
      const dist = Math.abs(fire.x - goblin.x) + Math.abs(fire.y - goblin.y);
      if (dist <= 1) {
        goblin.carryingWater = false;
        addWorkFatigue(goblin);
        if (Math.random() < DOUSE_CHANCE) {
          const t = grid2[fire.y][fire.x];
          grid2[fire.y][fire.x] = {
            type: "dirt" /* Dirt */,
            foodValue: 0,
            maxFood: 0,
            materialValue: 0,
            maxMaterial: 0,
            growbackRate: 0,
            trafficScore: t.trafficScore
          };
          goblin.task = "\u{1F6BF} doused the fire!";
          if (shouldLog(goblin, "dousedFire", currentTick, 30)) {
            onLog?.(`\u{1F6BF} ${goblin.name} doused a fire tile!`, "info");
          }
        } else {
          goblin.task = "missed the fire!";
        }
        if (Math.random() < SINGE_CHANCE && !goblin.onFire) {
          goblin.onFire = true;
          goblin.onFireTick = currentTick;
          goblin.morale = Math.max(0, goblin.morale - SINGE_MOR_LOSS);
          onLog?.(`\u{1F525} ${goblin.name} caught fire while fighting the flames!`, "warn");
        }
      } else {
        moveTo(goblin, fire, grid2);
        goblin.task = `\u2192 fire (bucket ready, ${dist} tiles)`;
      }
    }
  }
};

// src/simulation/actions/stockpiling.ts
function mostNeededStockpileType(ctx) {
  const foodCap = ctx.foodStockpiles?.reduce((s, sp) => s + sp.maxFood, 0) ?? 0;
  const foodAmt = ctx.foodStockpiles?.reduce((s, sp) => s + sp.food, 0) ?? 0;
  const oreCap = ctx.oreStockpiles?.reduce((s, sp) => s + sp.maxOre, 0) ?? 0;
  const oreAmt = ctx.oreStockpiles?.reduce((s, sp) => s + sp.ore, 0) ?? 0;
  const woodCap = ctx.woodStockpiles?.reduce((s, sp) => s + sp.maxWood, 0) ?? 0;
  const woodAmt = ctx.woodStockpiles?.reduce((s, sp) => s + sp.wood, 0) ?? 0;
  const foodRatio = foodCap > 0 ? foodAmt / foodCap : 0;
  const oreRatio = oreCap > 0 ? oreAmt / oreCap : 0;
  const woodRatio = woodCap > 0 ? woodAmt / woodCap : 0;
  const rooms2 = ctx.rooms ?? [];
  const candidates = [
    { type: "food", ratio: foodRatio },
    { type: "ore", ratio: oreRatio },
    { type: "wood", ratio: woodRatio }
  ];
  for (const c of candidates) {
    const hasUnfull = rooms2.some((r) => r.specialization === c.type);
    if (hasUnfull && c.ratio < 1) c.ratio += 10;
  }
  candidates.sort((a, b) => a.ratio - b.ratio);
  return candidates[0].type;
}
var establishStockpile = {
  name: "establishStockpile",
  eligible: ({ rooms: rooms2, foodStockpiles: foodStockpiles2, goblins: goblins2 }) => {
    if (!rooms2 || rooms2.length === 0) return false;
    if (!rooms2.some((r) => r.specialization === void 0)) return false;
    const totalFood = (foodStockpiles2?.reduce((s, sp) => s + sp.food, 0) ?? 0) + (goblins2?.reduce((s, g) => g.alive ? s + g.inventory.food : s, 0) ?? 0);
    if (totalFood < 5) return false;
    return true;
  },
  score: ({ goblin }) => {
    return 0.4 * inverseSigmoid(goblin.hunger, 50);
  },
  execute: (ctx) => {
    const { goblin, grid: grid2, rooms: rooms2, foodStockpiles: foodStockpiles2, oreStockpiles: oreStockpiles2, woodStockpiles: woodStockpiles2, onLog } = ctx;
    if (!rooms2) return;
    let nearest = null;
    let nearDist = Infinity;
    for (const r of rooms2) {
      if (r.specialization !== void 0) continue;
      const cx2 = r.x + 2, cy2 = r.y + 2;
      const dist = Math.abs(cx2 - goblin.x) + Math.abs(cy2 - goblin.y);
      if (dist < nearDist) {
        nearDist = dist;
        nearest = r;
      }
    }
    if (!nearest) return;
    const cx = nearest.x + 2, cy = nearest.y + 2;
    if (goblin.x !== cx || goblin.y !== cy) {
      moveTo(goblin, { x: cx, y: cy }, grid2);
      goblin.task = "\u2192 storage room";
      return;
    }
    const specType = mostNeededStockpileType(ctx);
    nearest.specialization = specType;
    if (specType === "food" && foodStockpiles2) {
      foodStockpiles2.push({ x: cx, y: cy, food: 0, maxFood: 200 });
    } else if (specType === "ore" && oreStockpiles2) {
      oreStockpiles2.push({ x: cx, y: cy, ore: 0, maxOre: 200 });
    } else if (specType === "wood" && woodStockpiles2) {
      woodStockpiles2.push({ x: cx, y: cy, wood: 0, maxWood: 200 });
    }
    addWorkFatigue(goblin);
    goblin.task = `established ${specType} storage!`;
    onLog?.(`designated a new ${specType} storage room!`, "info");
  }
};

// src/simulation/actions/cooking.ts
var MEALS_PER_BATCH = 5;
var FOOD_COST = 5;
var WOOD_COST = 1;
var COOKING_TICKS_REQUIRED = 50;
var FIRE_CHANCE_PER_TICK = 0.015;
var cook = {
  name: "cook",
  eligible: ({ rooms: rooms2, foodStockpiles: foodStockpiles2, woodStockpiles: woodStockpiles2, goblin, grid: grid2 }) => {
    if (!rooms2 || rooms2.length === 0) return false;
    const hasKitchen = rooms2.some((r) => r.type === "kitchen");
    if (!hasKitchen) return false;
    const hasFood = foodStockpiles2?.some((s) => s.food >= FOOD_COST);
    const hasWood = woodStockpiles2?.some((s) => s.wood >= WOOD_COST);
    let kitchenHasHearth = false;
    for (const r of rooms2) {
      if (r.type !== "kitchen") continue;
      for (let y = Math.max(0, r.y - 1); y <= Math.min(GRID_SIZE - 1, r.y + r.h); y++) {
        for (let x = Math.max(0, r.x - 1); x <= Math.min(GRID_SIZE - 1, r.x + r.w); x++) {
          if (grid2[y] && grid2[y][x] && grid2[y][x].type === "hearth" /* Hearth */) {
            kitchenHasHearth = true;
            break;
          }
        }
        if (kitchenHasHearth) break;
      }
      if (kitchenHasHearth) break;
    }
    if (!kitchenHasHearth) return false;
    return hasFood && hasWood || goblin.cookingProgress !== void 0 && goblin.cookingProgress > 0;
  },
  score: ({ goblin, foodStockpiles: foodStockpiles2 }) => {
    if (goblin.cookingProgress !== void 0 && goblin.cookingProgress > 0) {
      return 0.95;
    }
    const totalFood = foodStockpiles2?.reduce((s, p) => s + p.food, 0) ?? 0;
    const totalMeals = foodStockpiles2?.reduce((s, p) => s + p.meals, 0) ?? 0;
    if (totalFood < 10) return 0;
    const foodAbundance = ramp(totalFood, 10, 50);
    const mealScarcity = inverseSigmoid(totalMeals, 20);
    const base = foodAbundance * mealScarcity * 0.5 * inverseSigmoid(goblin.hunger, 50);
    const traitMultiplier = goblin.trait === "helpful" ? 1.5 : 1;
    const momentum = goblin.task.includes("kitchen") ? 0.15 : 0;
    return Math.min(1, base * traitMultiplier + momentum);
  },
  execute: ({ goblin, grid: grid2, rooms: rooms2, foodStockpiles: foodStockpiles2, woodStockpiles: woodStockpiles2, onLog }) => {
    const kitchen = rooms2.find((r) => r.type === "kitchen");
    if (!kitchen) return;
    if (goblin.x < kitchen.x || goblin.x >= kitchen.x + kitchen.w || goblin.y < kitchen.y || goblin.y >= kitchen.y + kitchen.h) {
      let targetX = kitchen.x + Math.floor(kitchen.w / 2);
      let targetY = kitchen.y + Math.floor(kitchen.h / 2);
      moveTo(goblin, { x: targetX, y: targetY }, grid2);
      goblin.task = "\u2192 kitchen";
      return;
    }
    if (goblin.cookingProgress === void 0) {
      const foodSource = nearestFoodStockpile(goblin, foodStockpiles2, (s) => s.food >= FOOD_COST);
      const woodSource = nearestWoodStockpile(goblin, woodStockpiles2, (s) => s.wood >= WOOD_COST);
      if (!foodSource || !woodSource) {
        goblin.task = "kitchen is missing ingredients";
        return;
      }
      foodSource.food -= FOOD_COST;
      woodSource.wood -= WOOD_COST;
      goblin.cookingProgress = 1;
      goblin.task = `cooking (starting...)`;
      return;
    }
    goblin.cookingProgress += 1;
    if (Math.random() < FIRE_CHANCE_PER_TICK) {
      grid2[goblin.y][goblin.x].type = "fire" /* Fire */;
      onLog?.(`\u{1F525} ${goblin.name} started a grease fire!`, "warn");
    }
    const pct = Math.floor(goblin.cookingProgress / COOKING_TICKS_REQUIRED * 100);
    goblin.task = `cooking (${pct}%)`;
    if (goblin.cookingProgress >= COOKING_TICKS_REQUIRED) {
      const target = nearestFoodStockpile(goblin, foodStockpiles2, () => true);
      if (target) {
        target.meals += MEALS_PER_BATCH;
        onLog?.(`\u{1F372} ${goblin.name} cooked ${MEALS_PER_BATCH} meals!`, "info");
      }
      goblin.cookingProgress = void 0;
      addWorkFatigue(goblin);
    }
  }
};

// src/simulation/actions/index.ts
var ALL_ACTIONS = [
  commandMove,
  eat,
  seekSafety,
  // danger-driven flee — high urgency, runs before rest/work
  fightFire,
  // fetch water → douse nearby fire; scores 0.75 when fire is in vision
  rest,
  share,
  fight,
  buildHearth,
  establishStockpile,
  cook,
  forage,
  depositFood,
  withdrawFood,
  mine,
  chop,
  depositOre,
  depositWood,
  buildWall,
  socialize,
  seekWarmth,
  // comfort nudge — low score, loses to most work actions
  avoidRival,
  wander
];

// src/simulation/utilityAI.ts
function sigmoid(value, midpoint, steepness = 0.15) {
  return 1 / (1 + Math.exp(-steepness * (value - midpoint)));
}
function inverseSigmoid(value, midpoint, steepness = 0.15) {
  return 1 - sigmoid(value, midpoint, steepness);
}
function ramp(value, min, max) {
  if (value <= min) return 0;
  if (value >= max) return 1;
  return (value - min) / (max - min);
}
function shouldLog2(goblin, key, tick, cooldown) {
  if (tick - (goblin.lastLoggedTicks[key] ?? -Infinity) < cooldown) return false;
  goblin.lastLoggedTicks[key] = tick;
  return true;
}
function updateNeeds(goblin, goblins2, currentTick, weatherMetabolismMod, warmthField2, weatherType, onLog) {
  goblin.hunger = Math.min(100, goblin.hunger + goblin.metabolism * weatherMetabolismMod);
  if (weatherType === "cold" && warmthField2) {
    const warmth = getWarmth(warmthField2, goblin.x, goblin.y);
    const coldPenalty = inverseSigmoid(warmth, 30, 0.12);
    if (coldPenalty > 0.05) {
      goblin.fatigue = Math.min(100, goblin.fatigue + 0.3 * coldPenalty);
      goblin.morale = Math.max(0, goblin.morale - 0.25 * coldPenalty);
      goblin.hunger = Math.min(100, goblin.hunger + goblin.metabolism * 0.2 * coldPenalty);
      if (shouldLog2(goblin, "freezing", currentTick, 150)) {
        onLog?.("\u{1F976} freezing in the open", "warn");
      }
    }
  }
  goblin.morale = Math.max(0, Math.min(
    100,
    goblin.morale - sigmoid(goblin.hunger, 60) * 0.5 + inverseSigmoid(goblin.hunger, 30) * 0.25
    // hunger below 30 → morale recovers
  ));
  const stressMod = inverseSigmoid(goblin.morale, 35) * 0.4;
  if (stressMod > 0.05) {
    goblin.hunger = Math.min(100, goblin.hunger + goblin.metabolism * stressMod);
    if (shouldLog2(goblin, "morale_low", currentTick, 200)) {
      onLog?.("\u{1F624} morale is dangerously low", "warn");
    }
  }
  goblin.fatigue = Math.max(0, goblin.fatigue - 0.5);
  const WOUND_FATIGUE_DRAIN = {
    bruised: 0.3,
    leg: 0.15,
    arm: 0.1,
    eye: 0.05
  };
  const woundDrain = goblin.wound ? WOUND_FATIGUE_DRAIN[goblin.wound.type] ?? 0 : 0;
  if (woundDrain > 0) {
    goblin.fatigue = Math.min(100, goblin.fatigue + woundDrain);
  }
  goblin.morale = Math.max(0, goblin.morale - sigmoid(goblin.fatigue, 80) * 0.25);
  if (goblin.fatigue > 80 && shouldLog2(goblin, "exhausted", currentTick, 150)) {
    onLog?.("\u{1F629} exhausted", "warn");
  }
  tickWoundHealing(goblin, currentTick, onLog);
  if (goblins2) {
    const FRIEND_RADIUS = traitMod(goblin, "generosityRange", 2) + 1;
    const FRIEND_REL = 40;
    const hasFriend = goblins2.some(
      (other) => other.id !== goblin.id && other.alive && Math.abs(other.x - goblin.x) <= FRIEND_RADIUS && Math.abs(other.y - goblin.y) <= FRIEND_RADIUS && (goblin.relations[other.id] ?? 50) >= FRIEND_REL
    );
    if (hasFriend) {
      const socialBonus = traitMod(goblin, "socialDecayBonus", 0);
      goblin.social = Math.max(0, goblin.social - (0.3 + socialBonus));
      goblin.lastSocialTick = currentTick;
    } else {
      const isolationTicks = currentTick - goblin.lastSocialTick;
      goblin.social = Math.min(100, goblin.social + Math.min(0.5, isolationTicks / 400));
    }
  }
  if (goblin.social > 40) {
    goblin.morale = Math.max(0, goblin.morale - sigmoid(goblin.social, 60) * 0.2);
    if (goblin.social > 60 && shouldLog2(goblin, "lonely", currentTick, 200)) {
      onLog?.("\u{1F614} feeling lonely", "warn");
    }
  }
}
var ACTION_DISPLAY_NAMES = {
  eat: "eating",
  rest: "resting",
  forage: "foraging",
  mine: "mining",
  chop: "logging",
  fight: "fighting",
  share: "sharing food",
  depositFood: "stockpiling food",
  withdrawFood: "raiding the stockpile",
  depositOre: "hauling ore",
  depositWood: "hauling wood",
  buildWall: "building",
  buildHearth: "building a hearth",
  seekWarmth: "seeking warmth",
  seekSafety: "fleeing to safety",
  socialize: "socializing",
  avoidRival: "avoiding a rival",
  wander: "exploring",
  commandMove: "following orders"
};
function tickAgentUtility(goblin, grid2, currentTick, goblins2, onLog, foodStockpiles2, adventurers2, oreStockpiles2, colonyGoal2, woodStockpiles2, weatherMetabolismMod, warmthField2, dangerField2, weatherType, rooms2) {
  if (!goblin.alive) return;
  if (!isWalkable(grid2, goblin.x, goblin.y)) {
    const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    for (const d of dirs) {
      if (isWalkable(grid2, goblin.x + d.x, goblin.y + d.y)) {
        goblin.x += d.x;
        goblin.y += d.y;
        break;
      }
    }
  }
  updateNeeds(goblin, goblins2, currentTick, weatherMetabolismMod ?? 1, warmthField2, weatherType, onLog);
  const stumbleChance = ramp(goblin.fatigue, 70, 100) * 0.6 + 0.2;
  if (goblin.fatigue > 70 && Math.random() < stumbleChance) {
    goblin.task = "exhausted\u2026";
    goblin.fatigue = Math.max(0, goblin.fatigue - 1.5);
    return;
  }
  if (goblin.inventory.food === 0 && goblin.inventory.meals === 0 && goblin.hunger >= 90) {
    const starveDmg = sigmoid(goblin.hunger, 95, 0.2) * 3e-3 * goblin.maxHealth;
    goblin.health -= starveDmg;
    goblin.morale = Math.max(0, goblin.morale - starveDmg);
    goblin.task = "starving!";
    if (shouldLog2(goblin, "starving", currentTick, 150)) {
      onLog?.(`is starving! (health ${goblin.health.toFixed(0)})`, "warn");
    }
    if (goblin.health <= 0) {
      goblin.alive = false;
      goblin.task = "dead";
      goblin.causeOfDeath = "starvation";
      onLog?.("has died of starvation!", "error");
      return;
    }
  }
  if (goblin.onFire) {
    goblin.carryingWater = false;
    const WATER_SEARCH = 30;
    let waterTarget = null;
    let bestDist = Infinity;
    const x0 = Math.max(0, goblin.x - WATER_SEARCH), x1 = Math.min(grid2[0].length - 1, goblin.x + WATER_SEARCH);
    const y0 = Math.max(0, goblin.y - WATER_SEARCH), y1 = Math.min(grid2.length - 1, goblin.y + WATER_SEARCH);
    for (let wy = y0; wy <= y1; wy++) {
      for (let wx = x0; wx <= x1; wx++) {
        const tt = grid2[wy][wx].type;
        if (tt !== "water" /* Water */ && tt !== "pool" /* Pool */) continue;
        const d = Math.abs(wx - goblin.x) + Math.abs(wy - goblin.y);
        if (d < bestDist) {
          bestDist = d;
          waterTarget = { x: wx, y: wy };
        }
      }
    }
    if (waterTarget) {
      const next = pathNextStep({ x: goblin.x, y: goblin.y }, waterTarget, grid2);
      goblin.x = next.x;
      goblin.y = next.y;
      goblin.task = `\u{1F525} ON FIRE! \u2192 water (${bestDist} tiles)`;
    } else {
      goblin.task = "\u{1F525} ON FIRE! (no water nearby!)";
    }
    return;
  }
  if (goblin.llmIntent && currentTick > goblin.llmIntentExpiry) {
    goblin.llmIntent = null;
  }
  const ctx = {
    goblin,
    grid: grid2,
    currentTick,
    goblins: goblins2,
    onLog,
    foodStockpiles: foodStockpiles2,
    adventurers: adventurers2,
    oreStockpiles: oreStockpiles2,
    woodStockpiles: woodStockpiles2,
    colonyGoal: colonyGoal2,
    warmthField: warmthField2,
    dangerField: dangerField2,
    weatherType,
    rooms: rooms2
  };
  let bestAction = null;
  let bestScore = -1;
  let secondName = "";
  let secondScore = -1;
  for (const action of ALL_ACTIONS) {
    if (!action.eligible(ctx)) continue;
    let score = action.score(ctx);
    if (goblin.llmIntent && action.intentMatch === goblin.llmIntent) {
      score = Math.min(1, score + 0.5);
    }
    if (score > bestScore) {
      secondScore = bestScore;
      secondName = bestAction?.name ?? "";
      bestScore = score;
      bestAction = action;
    } else if (score > secondScore) {
      secondScore = score;
      secondName = action.name;
    }
  }
  if (bestAction && secondScore >= 0 && bestScore - secondScore <= 0.03 && bestScore > 0.45) {
    if (shouldLog2(goblin, "close_call", currentTick, 400)) {
      const nameA = ACTION_DISPLAY_NAMES[bestAction.name] ?? bestAction.name;
      const nameB = ACTION_DISPLAY_NAMES[secondName] ?? secondName;
      onLog?.(`\u2696 agonizing over ${nameA} vs ${nameB}`, "info");
    }
  }
  goblin.task = idleDescription(goblin);
  if (bestAction) {
    bestAction.execute(ctx);
  }
  if (goblin.cookingProgress !== void 0 && !goblin.task.includes("cooking")) {
    goblin.cookingProgress = void 0;
    if (shouldLog2(goblin, "cooking_interrupted", currentTick, 100)) {
      onLog?.(`\u{1F525} ${goblin.name} abandoned their cooking! The food is ruined!`, "warn");
    }
  }
}
function idleDescription(goblin) {
  if (goblin.fatigue > 60) return "exhausted, catching breath";
  if (goblin.fatigue > 20) return "catching breath";
  if ((goblin.warmth ?? 100) < 20) return "looking for warmth";
  if (goblin.morale < 25) return "brooding";
  if (goblin.hunger > 70) return "desperately hungry";
  if (goblin.hunger > 50) return "hungry, looking for food";
  if (goblin.social > 65) return "feeling lonely";
  if ((goblin.warmth ?? 100) < 35) return "a bit chilly";
  return "idle";
}

// src/simulation/adventurers.ts
var RAID_INTERVAL_MIN = 500;
var RAID_INTERVAL_MAX = 900;
var WANDER_RANGE = 15;
var RAID_MIN_SIZE = 2;
var RAID_MAX_SIZE = 4;
var ADVENTURER_ATTACK_DAMAGE = 5;
var GOBLIN_FIGHT_BACK = 8;
var FIGHTER_FIGHT_BACK = 18;
var STAGGER_TICKS = 12;
var ADVENTURER_MOVE_SKIP = 4;
var nextRaidAt = RAID_INTERVAL_MIN + Math.floor(Math.random() * (RAID_INTERVAL_MAX - RAID_INTERVAL_MIN));
var nextAdventurerId = 0;
function resetAdventurers() {
  nextRaidAt = RAID_INTERVAL_MIN + Math.floor(Math.random() * (RAID_INTERVAL_MAX - RAID_INTERVAL_MIN));
  nextAdventurerId = 0;
}
var EDGE_NAMES = ["north", "east", "south", "west"];
function maybeSpawnRaid(grid2, goblins2, tick) {
  if (tick < nextRaidAt) return null;
  const alive2 = goblins2.filter((d) => d.alive);
  if (alive2.length === 0) return null;
  nextRaidAt = tick + RAID_INTERVAL_MIN + Math.floor(Math.random() * (RAID_INTERVAL_MAX - RAID_INTERVAL_MIN));
  const count = RAID_MIN_SIZE + Math.floor(Math.random() * (RAID_MAX_SIZE - RAID_MIN_SIZE));
  const edge = Math.floor(Math.random() * 4);
  const newGoblins = [];
  for (let i = 0; i < count; i++) {
    let x = 0, y = 0, attempts = 0;
    do {
      switch (edge) {
        case 0:
          x = Math.floor(Math.random() * GRID_SIZE);
          y = 0;
          break;
        case 1:
          x = GRID_SIZE - 1;
          y = Math.floor(Math.random() * GRID_SIZE);
          break;
        case 2:
          x = Math.floor(Math.random() * GRID_SIZE);
          y = GRID_SIZE - 1;
          break;
        default:
          x = 0;
          y = Math.floor(Math.random() * GRID_SIZE);
          break;
      }
      attempts++;
    } while (!isWalkable(grid2, x, y) && attempts < 30);
    if (!isWalkable(grid2, x, y)) continue;
    newGoblins.push({
      id: `adventurer-${nextAdventurerId++}`,
      x,
      y,
      health: 20,
      maxHealth: 20,
      targetId: null
    });
  }
  return newGoblins.length > 0 ? { adventurers: newGoblins, edge: EDGE_NAMES[edge], count: newGoblins.length } : null;
}
function tickAdventurers(adventurers2, goblins2, grid2, tick) {
  const result = { attacks: [], adventurerDeaths: [], kills: [], logs: [] };
  const alive2 = goblins2.filter((d) => d.alive);
  if (alive2.length === 0) return result;
  for (let gi = 0; gi < adventurers2.length; gi++) {
    const g = adventurers2[gi];
    if (!isWalkable(grid2, g.x, g.y)) {
      const dirs = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
      const escape = dirs.find((d) => isWalkable(grid2, g.x + d.x, g.y + d.y));
      if (escape) {
        g.x += escape.x;
        g.y += escape.y;
      }
    }
    if (g.staggeredUntil !== void 0 && tick < g.staggeredUntil) continue;
    if ((tick + gi) % ADVENTURER_MOVE_SKIP === 0) continue;
    let target = g.targetId ? alive2.find((d) => d.id === g.targetId) ?? null : null;
    if (!target) {
      target = alive2.reduce((best, d) => {
        const dist2 = Math.abs(d.x - g.x) + Math.abs(d.y - g.y);
        const bDist = best ? Math.abs(best.x - g.x) + Math.abs(best.y - g.y) : Infinity;
        return dist2 < bDist ? d : best;
      }, null);
      g.targetId = target?.id ?? null;
    }
    const onSameTile = alive2.find((d) => d.x === g.x && d.y === g.y);
    if (onSameTile) {
      const currentDist = target ? Math.abs(target.x - g.x) + Math.abs(target.y - g.y) : Infinity;
      if (currentDist > 2) {
        target = onSameTile;
        g.targetId = onSameTile.id;
      }
    }
    if (!target) continue;
    const dist = Math.abs(target.x - g.x) + Math.abs(target.y - g.y);
    if (dist === 0) {
      result.attacks.push({ goblinId: target.id, damage: ADVENTURER_ATTACK_DAMAGE });
      const baseDmg = target.role === "fighter" ? FIGHTER_FIGHT_BACK : GOBLIN_FIGHT_BACK;
      const dmg = Math.round((baseDmg + skillDamageBonus(target)) * woundDamageMultiplier(target));
      g.health -= dmg;
      g.staggeredUntil = tick + STAGGER_TICKS;
      if (g.health <= 0) {
        result.adventurerDeaths.push(g.id);
        result.kills.push({ goblinId: target.id });
      }
    } else if (dist > WANDER_RANGE) {
      const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
      for (let i = dirs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
      }
      for (const dir of dirs) {
        const nx = g.x + dir.x;
        const ny = g.y + dir.y;
        if (isWalkable(grid2, nx, ny)) {
          g.x = nx;
          g.y = ny;
          break;
        }
      }
    } else {
      const next = pathNextStep({ x: g.x, y: g.y }, { x: target.x, y: target.y }, grid2);
      g.x = next.x;
      g.y = next.y;
    }
  }
  return result;
}
function spawnInitialAdventurers(grid2, count) {
  const adventurers2 = [];
  for (let i = 0; i < count; i++) {
    let x = 0, y = 0, attempts = 0;
    do {
      x = Math.floor(Math.random() * GRID_SIZE);
      y = Math.floor(Math.random() * GRID_SIZE);
      attempts++;
    } while (!isWalkable(grid2, x, y) && attempts < 50);
    if (!isWalkable(grid2, x, y)) continue;
    adventurers2.push({
      id: `adventurer-${nextAdventurerId++}`,
      x,
      y,
      health: 20,
      maxHealth: 20,
      targetId: null
    });
  }
  return adventurers2;
}

// src/simulation/weather.ts
var SEASON_LENGTH = 600;
var WEATHER_SHIFT_CHANCE = 2e-3;
var GROWBACK_MODS = {
  clear: 1,
  rain: 1.8,
  // food grows almost twice as fast
  drought: 0.25,
  // food barely regenerates
  cold: 0.5,
  // slow growth
  storm: 2.5
  // torrential rain — fastest growback, offset by lightning risk
};
var METABOLISM_MODS = {
  clear: 1,
  rain: 1,
  drought: 1,
  cold: 1.4,
  // burn calories faster in cold
  storm: 1.2
  // stressful conditions burn extra energy
};
var SEASON_WEIGHTS = {
  spring: [0.25, 0.35, 0.05, 0.1, 0.25],
  // stormy spring
  summer: [0.45, 0.05, 0.35, 0, 0.15],
  // summer thunderstorms; no cold
  autumn: [0.35, 0.25, 0.1, 0.15, 0.15],
  // mixed, moderate storms
  winter: [0.15, 0.1, 0, 0.75, 0]
  // cold dominates; no storms or drought
};
var SEASONS = ["spring", "summer", "autumn", "winter"];
var WEATHER_TYPES = ["clear", "rain", "drought", "cold", "storm"];
function pickWeather(season) {
  const weights = SEASON_WEIGHTS[season];
  const roll = Math.random();
  let cumulative = 0;
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i];
    if (roll < cumulative) return WEATHER_TYPES[i];
  }
  return "clear";
}
function nextSeason(current) {
  const idx2 = SEASONS.indexOf(current);
  return SEASONS[(idx2 + 1) % SEASONS.length];
}
function createWeather(tick) {
  const season = SEASONS[0];
  return {
    type: pickWeather(season),
    season,
    seasonStart: tick
  };
}
function tickWeather(weather2, tick) {
  const ticksInSeason = tick - weather2.seasonStart;
  if (ticksInSeason >= SEASON_LENGTH) {
    const oldSeason = weather2.season;
    weather2.season = nextSeason(oldSeason);
    weather2.seasonStart = tick;
    weather2.type = pickWeather(weather2.season);
    return `Season changed: ${oldSeason} \u2192 ${weather2.season} (${weather2.type})`;
  }
  if (Math.random() < WEATHER_SHIFT_CHANCE) {
    const oldType = weather2.type;
    weather2.type = pickWeather(weather2.season);
    if (weather2.type !== oldType) {
      return `Weather shifted: ${oldType} \u2192 ${weather2.type}`;
    }
  }
  return null;
}
function growbackModifier(weather2) {
  return GROWBACK_MODS[weather2.type];
}
function metabolismModifier(weather2) {
  return METABOLISM_MODS[weather2.type];
}

// src/simulation/events.ts
var AREA_SCALE = (GRID_SIZE / 64) ** 2;
var EVENT_MIN_INTERVAL = 300;
var EVENT_MAX_INTERVAL = 600;
var BLIGHT_RADIUS = 6;
var BLIGHT_SEVERITY = 0.5;
var BOUNTY_RADIUS = 5;
var BOUNTY_MULTIPLIER = 1.5;
var BOUNTY_MAX_VALUE = 20;
var MUSHROOM_ISOLATION_RADIUS = 4;
var MUSHROOM_SPREAD_RADIUS_MIN = 3;
var MUSHROOM_SPREAD_RADIUS_MAX = 5;
var MUSHROOM_FILL_CHANCE = 0.6;
var MUSHROOM_MAX_COUNT = Math.floor(14 * AREA_SCALE);
var MUSHROOM_FOOD_MIN = 3;
var MUSHROOM_FOOD_MAX = 5;
var ORE_DISCOVERY_RADIUS = 3;
var ORE_DISCOVERY_MAX_TILES = 5;
var ORE_DISCOVERY_VALUE = 15;
var MUSHROOM_SPROUT_INTERVAL = 60;
var MUSHROOM_SPROUT_RADIUS = 2;
var MUSHROOM_SPROUT_FILL = 0.7;
var MUSHROOM_SPROUT_MAX = Math.floor(8 * AREA_SCALE);
var TENSION_PER_THREAT = 15;
var TENSION_PER_DEAD = 20;
var TENSION_EVENT_DISTRIBUTION = {
  high: { blight: 0, bounty: 0.45, mushroom: 0.4, ore: 0.15 },
  // tension > 70: relief
  low: { blight: 0.5, bounty: 0, mushroom: 0.25, ore: 0.25 },
  // tension < 30: challenge
  normal: { blight: 0.25, bounty: 0.25, mushroom: 0.25, ore: 0.25 }
  // otherwise: uniform
};
var nextEventTick = EVENT_MIN_INTERVAL;
function scheduleNext() {
  nextEventTick += EVENT_MIN_INTERVAL + Math.floor(Math.random() * (EVENT_MAX_INTERVAL - EVENT_MIN_INTERVAL));
}
function setNextEventTick(tick) {
  nextEventTick = tick;
}
function randomItem(arr) {
  return arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : void 0;
}
function coordsInRadius(grid2, cx, cy, radius) {
  const result = [];
  const rows = grid2.length;
  const cols = grid2[0]?.length ?? 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < cols && y >= 0 && y < rows) {
        result.push({ x, y });
      }
    }
  }
  return result;
}
function applyBlight(grid2) {
  const candidates = [];
  for (let y = 0; y < grid2.length; y++) {
    for (let x = 0; x < (grid2[0]?.length ?? 0); x++) {
      if (grid2[y][x].maxFood > 0) candidates.push({ x, y });
    }
  }
  const centre = randomItem(candidates);
  if (!centre) return null;
  const affected = coordsInRadius(grid2, centre.x, centre.y, BLIGHT_RADIUS);
  for (const { x, y } of affected) {
    const t = grid2[y][x];
    if (t.maxFood > 0) {
      t.maxFood = Math.max(1, Math.floor(t.maxFood * BLIGHT_SEVERITY));
      t.foodValue = Math.min(t.foodValue, t.maxFood);
    }
  }
  return `Blight struck at (${centre.x},${centre.y}) \u2014 food yields halved in a ${BLIGHT_RADIUS}-tile radius`;
}
function applyBounty(grid2) {
  const candidates = [];
  for (let y = 0; y < grid2.length; y++) {
    for (let x = 0; x < (grid2[0]?.length ?? 0); x++) {
      if (grid2[y][x].maxFood > 0) candidates.push({ x, y });
    }
  }
  const centre = randomItem(candidates);
  if (!centre) return null;
  const affected = coordsInRadius(grid2, centre.x, centre.y, BOUNTY_RADIUS);
  for (const { x, y } of affected) {
    const t = grid2[y][x];
    if (t.maxFood > 0) {
      t.maxFood = Math.min(BOUNTY_MAX_VALUE, Math.ceil(t.maxFood * BOUNTY_MULTIPLIER));
      t.foodValue = Math.min(BOUNTY_MAX_VALUE, Math.ceil(t.foodValue * BOUNTY_MULTIPLIER));
    }
  }
  return `Bountiful harvest at (${centre.x},${centre.y}) \u2014 food yields boosted in a ${BOUNTY_RADIUS}-tile radius`;
}
function applyMushroomSpread(grid2) {
  const rows = grid2.length;
  const cols = grid2[0]?.length ?? 0;
  const candidates = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = grid2[y][x];
      if (t.type !== "dirt" /* Dirt */ && t.type !== "grass" /* Grass */) continue;
      const nearMushroom = coordsInRadius(grid2, x, y, MUSHROOM_ISOLATION_RADIUS).some(({ x: nx, y: ny }) => grid2[ny][nx].type === "mushroom" /* Mushroom */);
      if (!nearMushroom) candidates.push({ x, y });
    }
  }
  const centre = randomItem(candidates);
  if (!centre) return null;
  const radius = MUSHROOM_SPREAD_RADIUS_MIN + Math.floor(Math.random() * (MUSHROOM_SPREAD_RADIUS_MAX - MUSHROOM_SPREAD_RADIUS_MIN));
  const affected = coordsInRadius(grid2, centre.x, centre.y, radius);
  let count = 0;
  for (const { x, y } of affected) {
    const t = grid2[y][x];
    if ((t.type === "dirt" /* Dirt */ || t.type === "grass" /* Grass */) && Math.random() < MUSHROOM_FILL_CHANCE && count < MUSHROOM_MAX_COUNT) {
      const fMax = MUSHROOM_FOOD_MIN + Math.floor(Math.random() * (MUSHROOM_FOOD_MAX - MUSHROOM_FOOD_MIN));
      grid2[y][x] = { type: "mushroom" /* Mushroom */, foodValue: fMax, maxFood: fMax, materialValue: 0, maxMaterial: 0, growbackRate: 0.08 };
      count++;
    }
  }
  if (count === 0) return null;
  return `Mushrooms sprouted near (${centre.x},${centre.y}) \u2014 ${count} new patches`;
}
function applyOreDiscovery(grid2) {
  const candidates = [];
  for (let y = 0; y < grid2.length; y++) {
    for (let x = 0; x < (grid2[0]?.length ?? 0); x++) {
      const t = grid2[y][x];
      if (t.type !== "water" /* Water */ && t.type !== "ore" /* Ore */) {
        candidates.push({ x, y });
      }
    }
  }
  const centre = randomItem(candidates);
  if (!centre) return null;
  const affected = coordsInRadius(grid2, centre.x, centre.y, ORE_DISCOVERY_RADIUS);
  let count = 0;
  for (const { x, y } of affected) {
    const t = grid2[y][x];
    if (t.type !== "water" /* Water */ && t.type !== "ore" /* Ore */ && count < ORE_DISCOVERY_MAX_TILES) {
      t.type = "ore" /* Ore */;
      t.maxMaterial = ORE_DISCOVERY_VALUE;
      t.materialValue = ORE_DISCOVERY_VALUE;
      count++;
    }
  }
  return `Ore vein discovered near (${centre.x},${centre.y}) \u2014 ${count} new ore tiles`;
}
function tickMushroomSprout(grid2, tick) {
  if (tick === 0 || tick % MUSHROOM_SPROUT_INTERVAL !== 0) return null;
  const rows = grid2.length;
  const cols = grid2[0]?.length ?? 0;
  const candidates = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = grid2[y][x];
      if (t.type !== "dirt" /* Dirt */ && t.type !== "grass" /* Grass */) continue;
      const nearMushroom = coordsInRadius(grid2, x, y, MUSHROOM_SPROUT_RADIUS).some(({ x: nx, y: ny }) => grid2[ny][nx].type === "mushroom" /* Mushroom */);
      if (!nearMushroom) candidates.push({ x, y });
    }
  }
  const centre = randomItem(candidates);
  if (!centre) return null;
  const affected = coordsInRadius(grid2, centre.x, centre.y, MUSHROOM_SPROUT_RADIUS);
  let count = 0;
  for (const { x, y } of affected) {
    const t = grid2[y][x];
    if ((t.type === "dirt" /* Dirt */ || t.type === "grass" /* Grass */) && Math.random() < MUSHROOM_SPROUT_FILL && count < MUSHROOM_SPROUT_MAX) {
      const fMax = MUSHROOM_FOOD_MIN + Math.floor(Math.random() * (MUSHROOM_FOOD_MAX - MUSHROOM_FOOD_MIN));
      grid2[y][x] = { type: "mushroom" /* Mushroom */, foodValue: fMax, maxFood: fMax, materialValue: 0, maxMaterial: 0, growbackRate: 0.08 };
      count++;
    }
  }
  if (count === 0) return null;
  return `A mushroom patch sprouted near (${centre.x},${centre.y})`;
}
function colonyTension(goblins2, adventurers2) {
  if (!goblins2 || goblins2.length === 0) return 50;
  const alive2 = goblins2.filter((d) => d.alive);
  if (alive2.length === 0) return 100;
  const avgHunger = alive2.reduce((s, d) => s + d.hunger, 0) / alive2.length;
  const avgMorale = alive2.reduce((s, d) => s + d.morale, 0) / alive2.length;
  const threatMod = (adventurers2?.length ?? 0) * TENSION_PER_THREAT;
  const recentDead = goblins2.filter((d) => !d.alive).length * TENSION_PER_DEAD;
  return Math.min(100, avgHunger + (100 - avgMorale) * 0.5 + threatMod + recentDead);
}
function chooseEvent(tension) {
  const roll = Math.random();
  let distribution;
  if (tension > 70) {
    distribution = TENSION_EVENT_DISTRIBUTION.high;
  } else if (tension < 30) {
    distribution = TENSION_EVENT_DISTRIBUTION.low;
  } else {
    distribution = TENSION_EVENT_DISTRIBUTION.normal;
  }
  const types = ["blight", "bounty", "mushroom", "ore"];
  const weights = types.map((t) => distribution[t]);
  const total = weights.reduce((s, w) => s + w, 0);
  let cumulative = 0;
  for (let i = 0; i < types.length; i++) {
    cumulative += weights[i] / total;
    if (roll < cumulative) return types[i];
  }
  return types[types.length - 1];
}
function tickWorldEvents(grid2, tick, goblins2, adventurers2) {
  if (tick < nextEventTick) return { fired: false, message: "" };
  scheduleNext();
  const tension = colonyTension(goblins2, adventurers2);
  const event = chooseEvent(tension);
  let msg = null;
  switch (event) {
    case "blight":
      msg = applyBlight(grid2);
      break;
    case "bounty":
      msg = applyBounty(grid2);
      break;
    case "ore":
      msg = applyOreDiscovery(grid2);
      break;
    case "mushroom":
      msg = applyMushroomSpread(grid2);
      break;
  }
  if (!msg) return { fired: false, message: "" };
  return { fired: true, message: msg };
}

// scripts/headless.ts
var TICKS = parseInt(process.argv[2] ?? "2000", 10);
var SEED_ARG = process.argv[3] ? parseInt(process.argv[3], 10) : void 0;
var DUMP_JSON = process.env["DUMP_JSON"] === "1";
var snapshots = [];
var actionCounts = {};
var deathLog = [];
var raidLog = [];
var goalLog = [];
var warnLog = [];
var fireLog = [];
var fireTilesMax = 0;
var fireTilesTotal = 0;
var fireTilesRainedOut = 0;
function recordAction(task) {
  const key = task.startsWith("\u2192") ? "traveling" : task.replace(/\s*[(→].*/, "").trim() || "idle";
  actionCounts[key] = (actionCounts[key] ?? 0) + 1;
}
function findNextStockpileSlot(existing, allOccupied, grid2, otherGroup) {
  const anchor = existing[0];
  const occupiedSet = new Set(allOccupied.map((p) => `${p.x},${p.y}`));
  const expandDir = !otherGroup || otherGroup.length === 0 ? -1 : otherGroup[0].x > anchor.x ? -1 : 1;
  const colOffsets = [0, expandDir * 1, expandDir * 2];
  const isValid = (x, y) => x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE && !occupiedSet.has(`${x},${y}`) && grid2[y][x].type !== "water" /* Water */ && grid2[y][x].type !== "wall" /* Wall */;
  const rows = [...new Set(existing.map((p) => p.y))].sort((a, b) => a - b);
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
var GOAL_CYCLE = ["stockpile_food", "survive_ticks", "defeat_adventurers", "enclose_fort"];
function makeGoal(type, generation) {
  const scale = 1 + generation * 0.6;
  const desc = getActiveFaction().goalDescriptions;
  switch (type) {
    case "stockpile_food":
      return { type, description: desc.stockpile_food(Math.round(80 * scale)), progress: 0, target: Math.round(80 * scale), generation };
    case "survive_ticks":
      return { type, description: desc.survive_ticks(Math.round(800 * scale)), progress: 0, target: Math.round(800 * scale), generation };
    case "defeat_adventurers":
      return { type, description: desc.defeat_adventurers(Math.round(5 * scale)), progress: 0, target: Math.round(5 * scale), generation };
    case "enclose_fort":
      return { type, description: desc.enclose_fort(), progress: 0, target: 1, generation };
  }
}
console.log(`
\u{1F9CC} Kobold headless sim \u2014 ${TICKS} ticks${SEED_ARG !== void 0 ? `, seed ${SEED_ARG}` : ""}
`);
var { grid, spawnZone, seed } = generateWorld(SEED_ARG?.toString());
console.log(`   World seed: ${seed}`);
var totalForageable = 0;
var forageableNearSpawn = 0;
var spawnCx = spawnZone.x + Math.floor(spawnZone.w / 2);
var spawnCy = spawnZone.y + Math.floor(spawnZone.h / 2);
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
console.log(`   Total: ${totalForageable} ${[...FORAGEABLE_TILES].join("/")} tiles across ${GRID_SIZE}x${GRID_SIZE} map`);
var goblins = spawnGoblins(grid, spawnZone);
var adventurers = spawnInitialAdventurers(grid, 3);
resetAdventurers();
var depotX = Math.floor(spawnZone.x + spawnZone.w / 2);
var depotY = Math.floor(spawnZone.y + spawnZone.h / 2);
var rooms = [
  { id: "room-food", type: "storage", x: depotX - 2, y: depotY - 2, w: 5, h: 5, specialization: "food" },
  { id: "room-ore", type: "storage", x: depotX + 6, y: depotY - 2, w: 5, h: 5, specialization: "ore" },
  { id: "room-wood", type: "storage", x: depotX - 10, y: depotY - 2, w: 5, h: 5, specialization: "wood" }
];
var foodStockpiles = [{ x: depotX, y: depotY, food: 0, maxFood: 200 }];
var oreStockpiles = [{ x: depotX + 8, y: depotY, ore: 150, maxOre: 200 }];
var woodStockpiles = [{ x: depotX - 8, y: depotY, wood: 0, maxWood: 200 }];
for (const g of goblins) g.homeTile = { x: depotX, y: depotY };
var colonyGoal = makeGoal("stockpile_food", 0);
var goalStartTick = 0;
var adventurerKills = 0;
var pendingSuccessions = [];
var combatHits = /* @__PURE__ */ new Map();
var weather = createWeather(0);
var warmthField = createWarmthField();
var dangerField = createDangerField();
var dangerPrev = createDangerField();
setNextEventTick(300 + Math.floor(Math.random() * 300));
var t0 = Date.now();
for (let tick = 1; tick <= TICKS; tick++) {
  tickWeather(weather, tick);
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
  for (const g of goblins) {
    const wasAlive = g.alive;
    tickAgentUtility(
      g,
      grid,
      tick,
      goblins,
      (message, level) => {
        if (level === "warn" || level === "error") {
          warnLog.push({ tick, name: g.name, message });
        }
      },
      foodStockpiles,
      adventurers,
      oreStockpiles,
      colonyGoal,
      woodStockpiles,
      metabolismModifier(weather),
      warmthField,
      dangerField,
      weather.type,
      rooms
    );
    if (g.alive) recordAction(g.task);
    if (wasAlive && !g.alive) {
      deathLog.push({ tick, name: g.name, cause: g.causeOfDeath ?? "unknown" });
      pendingSuccessions.push({ deadGoblinId: g.id, spawnAtTick: tick + SUCCESSION_DELAY });
    }
  }
  tickBurningGoblins(grid, tick, goblins, (msg, level) => {
    if (level === "warn" || level === "error") fireLog.push({ tick, message: msg });
  });
  growback(grid, growbackModifier(weather), tick);
  tickPooling(grid, tick, weather.type);
  tickLightning(grid, tick, weather.type, (msg, level) => {
    if (level === "warn" || level === "error") fireLog.push({ tick, message: msg });
  });
  const fireResult = tickFire(grid, tick, goblins, weather.type, (msg, level) => {
    if (level === "warn" || level === "error") fireLog.push({ tick, message: msg });
  });
  fireTilesTotal += fireResult.burnouts;
  fireTilesRainedOut += fireResult.extinguished;
  let fireTileCount = 0;
  for (let fy = 0; fy < GRID_SIZE; fy++)
    for (let fx = 0; fx < GRID_SIZE; fx++)
      if (grid[fy][fx].type === "fire" /* Fire */) fireTileCount++;
  if (fireTileCount > fireTilesMax) fireTilesMax = fireTileCount;
  const raid = maybeSpawnRaid(grid, goblins, tick);
  if (raid) {
    adventurers.push(...raid.adventurers);
    raidLog.push({ tick, count: raid.count });
  }
  if (adventurers.length > 0) {
    const gr = tickAdventurers(adventurers, goblins, grid, tick);
    for (const { goblinId, damage } of gr.attacks) {
      const g = goblins.find((d) => d.id === goblinId);
      if (g && g.alive) {
        g.health = Math.max(0, g.health - damage);
        g.morale = Math.max(0, g.morale - 5);
        if (g.health <= 0) {
          g.alive = false;
          g.task = "dead";
          g.causeOfDeath = "killed by adventurers";
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
    adventurers = adventurers.filter((a) => !deadIds.has(a.id));
    combatHits.forEach((_, id) => {
      if (deadIds.has(id)) combatHits.delete(id);
    });
  }
  tickWorldEvents(grid, tick, goblins, adventurers);
  tickMushroomSprout(grid, tick);
  for (let i = pendingSuccessions.length - 1; i >= 0; i--) {
    const s = pendingSuccessions[i];
    if (tick < s.spawnAtTick) continue;
    pendingSuccessions.splice(i, 1);
    const dead = goblins.find((g) => g.id === s.deadGoblinId);
    if (!dead) continue;
    const successor = spawnSuccessor(dead, grid, spawnZone, goblins, tick);
    const home = foodStockpiles[0] ?? { x: depotX, y: depotY };
    successor.homeTile = { x: home.x, y: home.y };
    goblins.push(successor);
    successor.llmReasoning = `I heard what happened to ${dead.name}. I will not make the same mistakes.`;
    successor.memory.push({ tick, crisis: "arrival", action: `arrived to replace ${dead.name}` });
  }
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
  const alive2 = goblins.filter((g) => g.alive);
  switch (colonyGoal.type) {
    case "stockpile_food":
      colonyGoal.progress = foodStockpiles.reduce((s, d) => s + d.food, 0);
      break;
    case "survive_ticks":
      colonyGoal.progress = tick - goalStartTick;
      break;
    case "defeat_adventurers":
      colonyGoal.progress = adventurerKills;
      break;
    case "enclose_fort": {
      const rem = roomWallSlots(rooms, grid, goblins, "", adventurers);
      colonyGoal.progress = rooms.length > 0 && rem.length === 0 ? 1 : 0;
      break;
    }
  }
  if (colonyGoal.progress >= colonyGoal.target) {
    for (const g of alive2) g.morale = Math.min(100, g.morale + 15);
    goalLog.push({ tick, type: colonyGoal.type, generation: colonyGoal.generation });
    const curr = GOAL_CYCLE.indexOf(colonyGoal.type);
    const next = GOAL_CYCLE[(curr + 1) % GOAL_CYCLE.length];
    if (next === "defeat_adventurers") adventurerKills = 0;
    goalStartTick = tick;
    colonyGoal = makeGoal(next, colonyGoal.generation + 1);
  }
  if (tick % 10 === 0) {
    const aliveNow = goblins.filter((g) => g.alive);
    snapshots.push({
      tick,
      alive: aliveNow.length,
      totalFood: foodStockpiles.reduce((s, d) => s + d.food, 0),
      totalOre: oreStockpiles.reduce((s, d) => s + d.ore, 0),
      totalWood: woodStockpiles.reduce((s, d) => s + d.wood, 0),
      avgHunger: aliveNow.length ? aliveNow.reduce((s, g) => s + g.hunger, 0) / aliveNow.length : 0,
      avgMorale: aliveNow.length ? aliveNow.reduce((s, g) => s + g.morale, 0) / aliveNow.length : 0,
      avgFatigue: aliveNow.length ? aliveNow.reduce((s, g) => s + g.fatigue, 0) / aliveNow.length : 0,
      raiders: adventurers.length
    });
  }
}
var elapsed = Date.now() - t0;
var alive = goblins.filter((g) => g.alive);
var last = snapshots[snapshots.length - 1];
console.log(`
${"\u2500".repeat(56)}`);
console.log(` RESULTS  (${TICKS} ticks in ${elapsed}ms \u2014 ${(TICKS / (elapsed / 1e3)).toFixed(0)} ticks/sec)`);
console.log(`${"\u2500".repeat(56)}`);
console.log(` Survivors:   ${alive.length} / ${goblins.length} total spawned`);
console.log(` Deaths:      ${deathLog.length}`);
console.log(` Raids:       ${raidLog.length} (${adventurerKills} adventurers killed)`);
console.log(` Goals done:  ${goalLog.length}`);
console.log(` Food stored: ${last?.totalFood.toFixed(0) ?? 0}`);
console.log(` Ore stored:  ${last?.totalOre.toFixed(0) ?? 0}`);
console.log(` Wood stored: ${last?.totalWood.toFixed(0) ?? 0}`);
console.log(` Avg hunger:  ${last?.avgHunger.toFixed(1) ?? "?"}`);
console.log(` Avg morale:  ${last?.avgMorale.toFixed(1) ?? "?"}`);
console.log(` Avg fatigue: ${last?.avgFatigue.toFixed(1) ?? "?"}`);
console.log(` Fire events: ${fireLog.length} ignitions \xB7 ${fireTilesTotal} tiles burned \xB7 ${fireTilesRainedOut} rained out \xB7 peak ${fireTilesMax} simultaneous`);
if (fireLog.length > 0) {
  console.log(`
 Fire events:`);
  for (const f of fireLog) {
    console.log(`   [${f.tick}] ${f.message}`);
  }
}
if (deathLog.length > 0) {
  console.log(`
 Deaths:`);
  for (const d of deathLog) {
    console.log(`   [${d.tick}] ${d.name} \u2014 ${d.cause}`);
  }
}
if (goalLog.length > 0) {
  console.log(`
 Goals completed:`);
  for (const g of goalLog) {
    console.log(`   [${g.tick}] ${g.type} (gen ${g.generation})`);
  }
}
console.log(`
 Action frequencies (top 15):`);
var sorted = Object.entries(actionCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
var maxCount = sorted[0]?.[1] ?? 1;
for (const [action, count] of sorted) {
  const bar = "\u2588".repeat(Math.round(count / maxCount * 20));
  const pct = (count / Object.values(actionCounts).reduce((a, b) => a + b, 0) * 100).toFixed(1);
  console.log(`   ${action.padEnd(24)} ${bar.padEnd(20)} ${pct}%`);
}
if (DUMP_JSON) {
  const outPath = `headless-${seed}-${TICKS}.json`;
  const fs = await import("node:fs/promises");
  await fs.writeFile(outPath, JSON.stringify({ seed, ticks: TICKS, snapshots, deathLog, raidLog, goalLog, actionCounts, warnLog, fireLog, fireTilesMax, fireTilesTotal }, null, 2));
  console.log(`
 JSON dumped \u2192 ${outPath}`);
}
console.log();
