/**
 * Behavior tree (legacy): tickAgent — priority cascade (starvation, eat, LLM intent,
 * command, forage, fort, mine/chop, wander/avoid). Used when utility AI is off.
 * Modules: sites, roles, pathfinding, fort.
 */

import { TileType, type Goblin, type Tile, type FoodStockpile, type OreStockpile, type WoodStockpile, type Adventurer, type ColonyGoal, type ResourceSite } from '../../shared/types';
import { GRID_SIZE, MAX_INVENTORY_CAPACITY } from '../../shared/constants';
import { getActiveFaction } from '../../shared/factions';
import { isWalkable } from '../world';
import { recordSite, SITE_RECORD_THRESHOLD, PATCH_MERGE_RADIUS, FORAGEABLE_TILES } from './sites';
import { traitMod } from './roles';
import { pathNextStep, bestFoodTile, bestMaterialTile, bestWoodTile } from './pathfinding';
import { fortWallSlots, fortEnclosureSlots } from './fort';

export type LogFn = (message: string, level: 'info' | 'warn' | 'error') => void;

export function tickAgent(
  goblin:              Goblin,
  grid:               Tile[][],
  currentTick:        number,
  goblins?:           Goblin[],
  onLog?:             LogFn,
  foodStockpiles?:    FoodStockpile[],
  adventurers?:       Adventurer[],
  oreStockpiles?:     OreStockpile[],
  _colonyGoal?:       ColonyGoal,
  woodStockpiles?:    WoodStockpile[],
  weatherMetabolismMod?: number,
): void {
  if (!goblin.alive) return;

  if (!isWalkable(grid, goblin.x, goblin.y)) {
    const dirs = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
    const escape = dirs.find(d => isWalkable(grid, goblin.x + d.x, goblin.y + d.y));
    if (escape) { goblin.x += escape.x; goblin.y += escape.y; }
  }

  goblin.hunger = Math.min(100, goblin.hunger + goblin.metabolism * (weatherMetabolismMod ?? 1));

  if (goblin.hunger > 60) {
    goblin.morale = Math.max(0, goblin.morale - 0.4);
  } else if (goblin.hunger < 30) {
    goblin.morale = Math.min(100, goblin.morale + 0.2);
  }
  if (goblin.morale < 25) {
    goblin.hunger = Math.min(100, goblin.hunger + goblin.metabolism * 0.3);
  }

  const fatigueRate = traitMod(goblin, 'fatigueRate', 1.0);
  goblin.fatigue = Math.max(0, goblin.fatigue - 0.05);
  if (goblin.fatigue > 90) {
    goblin.morale = Math.max(0, goblin.morale - 0.2);
  }

  if (goblins) {
    const FRIEND_RADIUS = 3;
    const FRIEND_REL = 40;
    const hasFriend = goblins.some(
      other => other.id !== goblin.id && other.alive &&
        Math.abs(other.x - goblin.x) <= FRIEND_RADIUS &&
        Math.abs(other.y - goblin.y) <= FRIEND_RADIUS &&
        (goblin.relations[other.id] ?? 50) >= FRIEND_REL,
    );
    if (hasFriend) {
      const socialBonus = traitMod(goblin, 'socialDecayBonus', 0);
      goblin.social = Math.max(0, goblin.social - (0.3 + socialBonus));
      goblin.lastSocialTick = currentTick;
    } else if (currentTick - goblin.lastSocialTick > 30) {
      goblin.social = Math.min(100, goblin.social + 0.15);
    }
  }
  if (goblin.social > 60) {
    goblin.morale = Math.max(0, goblin.morale - 0.15);
  }

  if (goblin.fatigue > 70 && Math.random() < 0.3) {
    goblin.task = 'exhausted…';
    goblin.fatigue = Math.max(0, goblin.fatigue - 0.5);
    return;
  }

  if (goblin.hunger >= 100 && goblin.inventory.food === 0) {
    goblin.health -= 2;
    goblin.morale = Math.max(0, goblin.morale - 2);
    goblin.task = 'starving!';
    onLog?.(`is starving! (health ${goblin.health})`, 'warn');
    if (goblin.health <= 0) {
      goblin.alive = false;
      goblin.task = 'dead';
      goblin.causeOfDeath = 'starvation';
      onLog?.('has died of starvation!', 'error');
      return;
    }
  }

  if (goblin.hunger > traitMod(goblin, 'eatThreshold', 70) && goblin.inventory.food > 0) {
    const bite = Math.min(goblin.inventory.food, 3);
    goblin.inventory.food -= bite;
    goblin.hunger = Math.max(0, goblin.hunger - bite * 20);
    goblin.task = 'eating';
    return;
  }

  if (goblin.llmIntent) {
    if (currentTick > goblin.llmIntentExpiry) {
      goblin.llmIntent = null;
    } else {
      switch (goblin.llmIntent) {
        case 'eat':
          if (goblin.inventory.food > 0 && goblin.hunger > 30) {
            const bite = Math.min(goblin.inventory.food, 3);
            goblin.inventory.food -= bite;
            goblin.hunger = Math.max(0, goblin.hunger - bite * 20);
            goblin.task = 'eating (LLM)';
            return;
          }
          break;
        case 'rest':
          goblin.fatigue = Math.max(0, goblin.fatigue - 1.5);
          goblin.task = 'resting';
          return;
        case 'socialize': {
          if (goblins) {
            const FRIEND_REL = 40;
            let bestDist = Infinity;
            let bestFriend: Goblin | null = null;
            for (const other of goblins) {
              if (other.id === goblin.id || !other.alive) continue;
              if ((goblin.relations[other.id] ?? 50) < FRIEND_REL) continue;
              const dist = Math.abs(other.x - goblin.x) + Math.abs(other.y - goblin.y);
              if (dist < bestDist) { bestDist = dist; bestFriend = other; }
            }
            if (bestFriend && bestDist > 1) {
              const step = pathNextStep({ x: goblin.x, y: goblin.y }, bestFriend, grid);
              goblin.x = step.x; goblin.y = step.y;
              goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate);
            }
            goblin.task = 'socializing';
            return;
          }
          break;
        }
        case 'forage':
        case 'avoid':
        case 'none':
          break;
      }
    }
  }

  const shareThresh = traitMod(goblin, 'shareThreshold', 8);
  const shareDonorKeeps = traitMod(goblin, 'shareDonorKeeps', 5);
  const shareRelGate = traitMod(goblin, 'shareRelationGate', 30);
  if (goblins && goblin.inventory.food >= shareThresh) {
    const SHARE_RADIUS = 2;
    const needy = goblins
      .filter(d =>
        d.alive && d.id !== goblin.id &&
        Math.abs(d.x - goblin.x) <= SHARE_RADIUS &&
        Math.abs(d.y - goblin.y) <= SHARE_RADIUS &&
        d.hunger > 60 && d.inventory.food < 3 &&
        (goblin.relations[d.id] ?? 50) >= shareRelGate,
      )
      .sort((a, b) => b.hunger - a.hunger)[0] ?? null;
    if (needy) {
      const gift = Math.min(3, goblin.inventory.food - shareDonorKeeps);
      if (gift > 0) {
        goblin.inventory.food -= gift;
        needy.inventory.food = Math.min(MAX_INVENTORY_CAPACITY, needy.inventory.food + gift);
        goblin.relations[needy.id] = Math.min(100, (goblin.relations[needy.id] ?? 50) + 10);
        needy.relations[goblin.id] = Math.min(100, (needy.relations[goblin.id] ?? 50) + 15);
        goblin.task = `sharing food → ${needy.name}`;
        onLog?.(`shared ${gift} food with ${needy.name} (hunger ${needy.hunger.toFixed(0)})`, 'info');
        goblin.memory.push({ tick: currentTick, crisis: 'food_sharing', action: `shared ${gift} food with ${needy.name}` });
        needy.memory.push({ tick: currentTick, crisis: 'food_sharing', action: `received ${gift} food from ${goblin.name}` });
        return;
      }
    }
  }

  const standingFoodStockpile = foodStockpiles?.find(d => d.x === goblin.x && d.y === goblin.y) ?? null;
  if (standingFoodStockpile) {
    if (goblin.inventory.food >= 10) {
      const amount = goblin.inventory.food - 6;
      const stored = Math.min(amount, standingFoodStockpile.maxFood - standingFoodStockpile.food);
      if (stored > 0) {
        standingFoodStockpile.food += stored;
        goblin.inventory.food -= stored;
        goblin.task = `deposited ${stored.toFixed(0)} → stockpile`;
        return;
      }
    }
    if (goblin.hunger > 60 && goblin.inventory.food < 2 && standingFoodStockpile.food > 0) {
      const amount = Math.min(4, standingFoodStockpile.food);
      standingFoodStockpile.food -= amount;
      goblin.inventory.food = Math.min(MAX_INVENTORY_CAPACITY, goblin.inventory.food + amount);
      goblin.task = `withdrew ${amount.toFixed(0)} from stockpile`;
      return;
    }
  }

  const standingOreStockpile = oreStockpiles?.find(s => s.x === goblin.x && s.y === goblin.y) ?? null;
  if (goblin.role === 'miner' && standingOreStockpile && goblin.inventory.ore > 0) {
    const stored = Math.min(goblin.inventory.ore, standingOreStockpile.maxOre - standingOreStockpile.ore);
    if (stored > 0) {
      standingOreStockpile.ore += stored;
      goblin.inventory.ore -= stored;
      goblin.task = `deposited ${stored.toFixed(0)} ore → stockpile`;
      return;
    }
  }

  const standingWoodStockpile = woodStockpiles?.find(s => s.x === goblin.x && s.y === goblin.y) ?? null;
  if (goblin.role === 'lumberjack' && standingWoodStockpile && goblin.inventory.wood > 0) {
    const stored = Math.min(goblin.inventory.wood, standingWoodStockpile.maxWood - standingWoodStockpile.wood);
    if (stored > 0) {
      standingWoodStockpile.wood += stored;
      goblin.inventory.wood -= stored;
      goblin.task = `deposited ${stored.toFixed(0)} wood → stockpile`;
      return;
    }
  }

  if (goblin.commandTarget) {
    const { x: tx, y: ty } = goblin.commandTarget;
    if (goblin.x === tx && goblin.y === ty) {
      onLog?.(`arrived at (${tx},${ty})`, 'info');
      goblin.commandTarget = null;
      goblin.task = 'arrived';
    } else {
      const next = pathNextStep({ x: goblin.x, y: goblin.y }, goblin.commandTarget, grid);
      goblin.x = next.x;
      goblin.y = next.y;
      goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate);
      goblin.task = `→ (${tx},${ty})`;
    }
    return;
  }

  const fleeAt = traitMod(goblin, 'fleeThreshold', 80);
  if (goblin.role === 'fighter' && adventurers && adventurers.length > 0 && goblin.hunger < fleeAt) {
    const HUNT_RADIUS = goblin.vision * 2;
    const nearest = adventurers.reduce<{ g: Adventurer; dist: number } | null>((best, g) => {
      const dist = Math.abs(g.x - goblin.x) + Math.abs(g.y - goblin.y);
      return (!best || dist < best.dist) ? { g, dist } : best;
    }, null);
    if (nearest && nearest.dist <= HUNT_RADIUS) {
      if (nearest.dist > 0) {
        const step1 = pathNextStep({ x: goblin.x, y: goblin.y }, { x: nearest.g.x, y: nearest.g.y }, grid);
        goblin.x = step1.x; goblin.y = step1.y;
        const step2 = pathNextStep({ x: goblin.x, y: goblin.y }, { x: nearest.g.x, y: nearest.g.y }, grid);
        goblin.x = step2.x; goblin.y = step2.y;
      }
      const distAfterMove = Math.abs(nearest.g.x - goblin.x) + Math.abs(nearest.g.y - goblin.y);
      goblin.fatigue = Math.min(100, goblin.fatigue + 0.4 * fatigueRate);
      const enemySing = getActiveFaction().enemyNounPlural.replace(/s$/, '');
      goblin.task = distAfterMove === 0 ? `fighting ${enemySing}!` : `→ ${enemySing} (${distAfterMove} tiles)`;
      return;
    }
  }

  const inventoryFull = goblin.inventory.food >= MAX_INVENTORY_CAPACITY;
  const skipFoodForage = inventoryFull
    || ((goblin.role === 'miner' || goblin.role === 'lumberjack') && goblin.hunger < 50 && goblin.llmIntent !== 'forage');
  const radius = goblin.llmIntent === 'forage' ? 15
    : goblin.hunger > 65 ? Math.min(goblin.vision * 2, 15) : goblin.vision;
  const foodTarget = skipFoodForage ? null : bestFoodTile(goblin, grid, radius);
  if (foodTarget) {
    const tv = grid[foodTarget.y][foodTarget.x].foodValue;
    if (tv >= SITE_RECORD_THRESHOLD) {
      recordSite(goblin.knownFoodSites, foodTarget.x, foodTarget.y, tv, currentTick);
    }
  }
  if (foodTarget) {
    if (goblin.x !== foodTarget.x || goblin.y !== foodTarget.y) {
      const next = pathNextStep({ x: goblin.x, y: goblin.y }, foodTarget, grid);
      goblin.x = next.x; goblin.y = next.y;
      goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate);
    }
    const here = grid[goblin.y][goblin.x];

    if (goblins) {
      const rival = goblins.find(d =>
        d.alive && d.id !== goblin.id &&
        d.x === goblin.x && d.y === goblin.y && d.hunger > goblin.hunger,
      );
      if (rival) {
        const relation = goblin.relations[rival.id] ?? 50;
        if (relation >= 60) {
          goblin.relations[rival.id] = Math.min(100, relation + 2);
          goblin.task = `sharing tile with ${rival.name}`;
          return;
        }
        const penalty = traitMod(goblin, 'contestPenalty', -5);
        goblin.relations[rival.id] = Math.max(0, relation + penalty);
        const escapeDirs = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
        const escapeOpen = escapeDirs
          .map(d => ({ x: goblin.x + d.dx, y: goblin.y + d.dy }))
          .filter(p => isWalkable(grid, p.x, p.y));
        if (escapeOpen.length > 0) {
          const step = escapeOpen[Math.floor(Math.random() * escapeOpen.length)];
          goblin.x = step.x; goblin.y = step.y;
        }
        goblin.task = `yielding to ${rival.name}`;
        return;
      }
    }

    const headroom = MAX_INVENTORY_CAPACITY - goblin.inventory.food;
    if (FORAGEABLE_TILES.has(here.type) && here.foodValue >= 1) {
      const depletionRate = goblin.role === 'forager' ? 6 : 5;
      const baseYield = goblin.role === 'forager' ? 2 : 1;
      const moraleScale = 0.5 + (goblin.morale / 100) * 0.5;
      const fatigueScale = goblin.fatigue > 70 ? 0.5 : 1.0;
      const harvestYield = Math.max(1, Math.round(baseYield * moraleScale * fatigueScale));
      goblin.fatigue = Math.min(100, goblin.fatigue + 0.4 * fatigueRate);
      const hadFood = here.foodValue;
      const depleted = Math.min(hadFood, depletionRate);
      here.foodValue = Math.max(0, hadFood - depleted);
      if (here.foodValue === 0) { here.type = TileType.Dirt; here.maxFood = 0; }
      const amount = Math.min(harvestYield, depleted, headroom);
      goblin.inventory.food += amount;
      const label = goblin.llmIntent === 'forage' ? 'foraging (LLM)' : 'harvesting';
      goblin.task = `${label} (food: ${goblin.inventory.food.toFixed(0)})`;
    } else {
      const label = goblin.llmIntent === 'forage' ? 'foraging (LLM)' : 'foraging';
      goblin.task = `${label} → (${foodTarget.x},${foodTarget.y})`;
    }
    return;
  }

  const nearestFoodStockpileWithCapacity = foodStockpiles
    ?.filter(d => d.food < d.maxFood)
    .reduce<FoodStockpile | null>((best, d) => {
      const dist = Math.abs(d.x - goblin.x) + Math.abs(d.y - goblin.y);
      const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
      return dist < bestDist ? d : best;
    }, null) ?? null;
  if (nearestFoodStockpileWithCapacity && goblin.inventory.food >= 10 && goblin.hunger < 55
      && !(goblin.x === nearestFoodStockpileWithCapacity.x && goblin.y === nearestFoodStockpileWithCapacity.y)) {
    const next = pathNextStep(
      { x: goblin.x, y: goblin.y },
      { x: nearestFoodStockpileWithCapacity.x, y: nearestFoodStockpileWithCapacity.y },
      grid,
    );
    goblin.x = next.x; goblin.y = next.y;
    goblin.task = `→ home (deposit)`;
    return;
  }

  const nearestFoodStockpileWithFood = foodStockpiles
    ?.filter(d => d.food > 0)
    .reduce<FoodStockpile | null>((best, d) => {
      const dist = Math.abs(d.x - goblin.x) + Math.abs(d.y - goblin.y);
      const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
      return dist < bestDist ? d : best;
    }, null) ?? null;
  if (nearestFoodStockpileWithFood
      && !(goblin.x === nearestFoodStockpileWithFood.x && goblin.y === nearestFoodStockpileWithFood.y)
      && goblin.hunger > 65 && goblin.inventory.food === 0) {
    const next = pathNextStep(
      { x: goblin.x, y: goblin.y },
      { x: nearestFoodStockpileWithFood.x, y: nearestFoodStockpileWithFood.y },
      grid,
    );
    goblin.x = next.x; goblin.y = next.y;
    goblin.task = `→ stockpile (${nearestFoodStockpileWithFood.food.toFixed(0)} food)`;
    return;
  }

  if (!skipFoodForage && goblin.knownFoodSites.length > 0) {
    const best = goblin.knownFoodSites.reduce((a, b) => b.value > a.value ? b : a);
    if (goblin.x === best.x && goblin.y === best.y) {
      const tileHere = grid[goblin.y][goblin.x];
      const stillGood = tileHere.foodValue >= 1 && FORAGEABLE_TILES.has(tileHere.type);
      if (!stillGood) {
        let better: ResourceSite | null = null;
        for (let dy = -PATCH_MERGE_RADIUS; dy <= PATCH_MERGE_RADIUS; dy++) {
          for (let dx = -PATCH_MERGE_RADIUS; dx <= PATCH_MERGE_RADIUS; dx++) {
            const nx = best.x + dx;
            const ny = best.y + dy;
            if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
            const t = grid[ny][nx];
            if (!FORAGEABLE_TILES.has(t.type) || t.foodValue < 1) continue;
            if (!better || t.foodValue > better.value) {
              better = { x: nx, y: ny, value: t.foodValue, tick: currentTick };
            }
          }
        }
        if (better) {
          goblin.knownFoodSites = goblin.knownFoodSites.map(
            s => (s.x === best.x && s.y === best.y) ? better! : s,
          );
        } else {
          goblin.knownFoodSites = goblin.knownFoodSites.filter(
            s => !(s.x === best.x && s.y === best.y),
          );
        }
      } else {
        recordSite(goblin.knownFoodSites, best.x, best.y, tileHere.foodValue, currentTick);
      }
    } else {
      const next = pathNextStep({ x: goblin.x, y: goblin.y }, best, grid);
      goblin.x = next.x; goblin.y = next.y;
      goblin.task = `→ remembered patch`;
      return;
    }
  }

  const buildStockpile = oreStockpiles?.find(s => s.ore >= 3) ?? null;
  if (goblin.role === 'miner' && foodStockpiles && foodStockpiles.length > 0
      && oreStockpiles && oreStockpiles.length > 0 && buildStockpile && goblin.hunger < 65) {
    let wallSlots = fortWallSlots(foodStockpiles, oreStockpiles, grid, goblins, goblin.id, adventurers);
    if (wallSlots.length === 0) {
      wallSlots = fortEnclosureSlots(foodStockpiles, oreStockpiles, grid, goblins, goblin.id, adventurers);
    }
    let nearestSlot: { x: number; y: number } | null = null;
    let nearestDist = Infinity;
    for (const s of wallSlots) {
      const dist = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
      if (dist > 0 && dist < nearestDist) { nearestDist = dist; nearestSlot = s; }
    }
    if (nearestSlot) {
      const next = pathNextStep(
        { x: goblin.x, y: goblin.y },
        { x: nearestSlot.x, y: nearestSlot.y },
        grid,
      );
      if (next.x === nearestSlot.x && next.y === nearestSlot.y) {
        const t = grid[nearestSlot.y][nearestSlot.x];
        grid[nearestSlot.y][nearestSlot.x] = {
          ...t,
          type: TileType.Wall,
          foodValue: 0,
          maxFood: 0,
          materialValue: 0,
          maxMaterial: 0,
          growbackRate: 0,
        };
        buildStockpile.ore -= 3;
        goblin.task = 'built fort wall!';
      } else {
        goblin.x = next.x; goblin.y = next.y;
        goblin.task = '→ fort wall';
      }
      return;
    }
  }

  const nearestOreStockpileWithCapacity = oreStockpiles
    ?.filter(s => s.ore < s.maxOre)
    .reduce<OreStockpile | null>((best, s) => {
      const dist = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
      const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
      return dist < bestDist ? s : best;
    }, null) ?? null;
  if (goblin.role === 'miner' && nearestOreStockpileWithCapacity && goblin.inventory.ore >= 8
      && !(goblin.x === nearestOreStockpileWithCapacity.x && goblin.y === nearestOreStockpileWithCapacity.y)) {
    const next = pathNextStep(
      { x: goblin.x, y: goblin.y },
      { x: nearestOreStockpileWithCapacity.x, y: nearestOreStockpileWithCapacity.y },
      grid,
    );
    goblin.x = next.x; goblin.y = next.y;
    goblin.task = `→ ore stockpile (${goblin.inventory.ore.toFixed(0)} ore)`;
    return;
  }

  const nearestWoodStockpileWithCapacity = woodStockpiles
    ?.filter(s => s.wood < s.maxWood)
    .reduce<WoodStockpile | null>((best, s) => {
      const dist = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
      const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
      return dist < bestDist ? s : best;
    }, null) ?? null;
  if (goblin.role === 'lumberjack' && nearestWoodStockpileWithCapacity && goblin.inventory.wood >= 8
      && !(goblin.x === nearestWoodStockpileWithCapacity.x && goblin.y === nearestWoodStockpileWithCapacity.y)) {
    const next = pathNextStep(
      { x: goblin.x, y: goblin.y },
      { x: nearestWoodStockpileWithCapacity.x, y: nearestWoodStockpileWithCapacity.y },
      grid,
    );
    goblin.x = next.x; goblin.y = next.y;
    goblin.task = `→ wood stockpile (${goblin.inventory.wood.toFixed(0)} wood)`;
    return;
  }

  if (goblin.role === 'miner' && goblin.knownOreSites.length > 0) {
    const best = goblin.knownOreSites.reduce((a, b) => b.value > a.value ? b : a);
    if (goblin.x === best.x && goblin.y === best.y) {
      const mv = grid[goblin.y][goblin.x].type !== TileType.Forest
        ? grid[goblin.y][goblin.x].materialValue : 0;
      if (mv < 1) {
        let better: ResourceSite | null = null;
        for (let dy = -PATCH_MERGE_RADIUS; dy <= PATCH_MERGE_RADIUS; dy++) {
          for (let dx = -PATCH_MERGE_RADIUS; dx <= PATCH_MERGE_RADIUS; dx++) {
            const nx = best.x + dx;
            const ny = best.y + dy;
            if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
            const t = grid[ny][nx];
            if (t.type === TileType.Forest) continue;
            if (t.materialValue < 1) continue;
            if (!better || t.materialValue > better.value) {
              better = { x: nx, y: ny, value: t.materialValue, tick: currentTick };
            }
          }
        }
        if (better) {
          goblin.knownOreSites = goblin.knownOreSites.map(
            s => (s.x === best.x && s.y === best.y) ? better! : s,
          );
        } else {
          goblin.knownOreSites = goblin.knownOreSites.filter(
            s => !(s.x === best.x && s.y === best.y),
          );
        }
      } else if (grid[goblin.y][goblin.x].type !== TileType.Forest) {
        recordSite(goblin.knownOreSites, best.x, best.y, mv, currentTick);
      }
    } else {
      const next = pathNextStep({ x: goblin.x, y: goblin.y }, best, grid);
      goblin.x = next.x; goblin.y = next.y;
      goblin.task = `→ remembered ore`;
      return;
    }
  }

  if (goblin.role === 'lumberjack' && goblin.knownWoodSites.length > 0) {
    const best = goblin.knownWoodSites.reduce((a, b) => b.value > a.value ? b : a);
    if (goblin.x === best.x && goblin.y === best.y) {
      const mv = grid[goblin.y][goblin.x].materialValue;
      if (mv < 1 || grid[goblin.y][goblin.x].type !== TileType.Forest) {
        let better: ResourceSite | null = null;
        for (let dy = -PATCH_MERGE_RADIUS; dy <= PATCH_MERGE_RADIUS; dy++) {
          for (let dx = -PATCH_MERGE_RADIUS; dx <= PATCH_MERGE_RADIUS; dx++) {
            const nx = best.x + dx;
            const ny = best.y + dy;
            if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
            const t = grid[ny][nx];
            if (t.type !== TileType.Forest || t.materialValue < 1) continue;
            if (!better || t.materialValue > better.value) {
              better = { x: nx, y: ny, value: t.materialValue, tick: currentTick };
            }
          }
        }
        if (better) {
          goblin.knownWoodSites = goblin.knownWoodSites.map(
            s => (s.x === best.x && s.y === best.y) ? better! : s,
          );
        } else {
          goblin.knownWoodSites = goblin.knownWoodSites.filter(
            s => !(s.x === best.x && s.y === best.y),
          );
        }
      } else {
        recordSite(goblin.knownWoodSites, best.x, best.y, mv, currentTick);
      }
    } else {
      const next = pathNextStep({ x: goblin.x, y: goblin.y }, best, grid);
      goblin.x = next.x; goblin.y = next.y;
      goblin.task = `→ remembered forest`;
      return;
    }
  }

  if (goblin.role === 'miner') {
    const oreTarget = bestMaterialTile(goblin, grid, goblin.vision);
    if (oreTarget) {
      const mv = grid[oreTarget.y][oreTarget.x].materialValue;
      if (mv >= SITE_RECORD_THRESHOLD) {
        recordSite(goblin.knownOreSites, oreTarget.x, oreTarget.y, mv, currentTick);
      }
    }
    if (oreTarget) {
      if (goblin.x !== oreTarget.x || goblin.y !== oreTarget.y) {
        const next = pathNextStep({ x: goblin.x, y: goblin.y }, oreTarget, grid);
        goblin.x = next.x; goblin.y = next.y;
        goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate);
      }
      const here = grid[goblin.y][goblin.x];
      if (here.materialValue >= 1) {
        const hadMat = here.materialValue;
        const mined = Math.min(hadMat, 2);
        here.materialValue = Math.max(0, hadMat - mined);
        if (here.materialValue === 0) { here.type = TileType.Stone; here.maxMaterial = 0; }
        goblin.inventory.ore = Math.min(goblin.inventory.ore + mined, MAX_INVENTORY_CAPACITY);
        goblin.fatigue = Math.min(100, goblin.fatigue + 0.4 * fatigueRate);
        goblin.task = `mining (ore: ${here.materialValue.toFixed(0)})`;
      } else {
        goblin.task = `mining → (${oreTarget.x},${oreTarget.y})`;
      }
      return;
    }
  }

  if (goblin.role === 'lumberjack') {
    const woodTarget = bestWoodTile(goblin, grid, goblin.vision);
    if (woodTarget) {
      const mv = grid[woodTarget.y][woodTarget.x].materialValue;
      if (mv >= SITE_RECORD_THRESHOLD) {
        recordSite(goblin.knownWoodSites, woodTarget.x, woodTarget.y, mv, currentTick);
      }
    }
    if (woodTarget) {
      if (goblin.x !== woodTarget.x || goblin.y !== woodTarget.y) {
        const next = pathNextStep({ x: goblin.x, y: goblin.y }, woodTarget, grid);
        goblin.x = next.x; goblin.y = next.y;
        goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate);
      }
      const here = grid[goblin.y][goblin.x];
      if (here.type === TileType.Forest && here.materialValue >= 1) {
        const hadWood = here.materialValue;
        const chopped = Math.min(hadWood, 2);
        here.materialValue = Math.max(0, hadWood - chopped);
        goblin.inventory.wood = Math.min(goblin.inventory.wood + chopped, MAX_INVENTORY_CAPACITY);
        goblin.fatigue = Math.min(100, goblin.fatigue + 0.4 * fatigueRate);
        goblin.task = `logging (wood: ${here.materialValue.toFixed(0)})`;
      } else {
        goblin.task = `→ forest (${woodTarget.x},${woodTarget.y})`;
      }
      return;
    }
  }

  const WANDER_HOLD_TICKS = 25;
  const WANDER_MIN_DIST = 10;
  const WANDER_MAX_DIST = 20;

  if (goblin.llmIntent === 'avoid' && goblins) {
    const rival = goblins
      .filter(r => r.alive && r.id !== goblin.id)
      .map(r => ({ r, dist: Math.abs(r.x - goblin.x) + Math.abs(r.y - goblin.y) }))
      .filter(e => e.dist <= 5)
      .sort((a, b) => a.dist - b.dist)[0]?.r ?? null;
    if (rival) {
      const avoidDirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
      const avoidOpen = avoidDirs
        .map(d => ({ x: goblin.x + d.x, y: goblin.y + d.y }))
        .filter(p => isWalkable(grid, p.x, p.y));
      if (avoidOpen.length > 0) {
        const next = avoidOpen.reduce((best, p) =>
          (Math.abs(p.x - rival.x) + Math.abs(p.y - rival.y)) >
          (Math.abs(best.x - rival.x) + Math.abs(best.y - rival.y)) ? p : best,
        );
        goblin.x = next.x; goblin.y = next.y;
        goblin.task = `avoiding ${rival.name}`;
      }
      return;
    }
  }

  if (goblin.wanderTarget && !isWalkable(grid, goblin.wanderTarget.x, goblin.wanderTarget.y)) {
    goblin.wanderTarget = null;
  }

  if (!goblin.wanderTarget || currentTick >= goblin.wanderExpiry
      || (goblin.x === goblin.wanderTarget.x && goblin.y === goblin.wanderTarget.y)) {
    let picked = false;
    const homeDrift = traitMod(goblin, 'wanderHomeDrift', 0.25);
    if (Math.random() < homeDrift && (goblin.homeTile.x !== 0 || goblin.homeTile.y !== 0)) {
      const hx = goblin.homeTile.x + Math.round((Math.random() - 0.5) * 20);
      const hy = goblin.homeTile.y + Math.round((Math.random() - 0.5) * 20);
      if (hx >= 0 && hx < GRID_SIZE && hy >= 0 && hy < GRID_SIZE && isWalkable(grid, hx, hy)) {
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
        if (wx >= 0 && wx < GRID_SIZE && wy >= 0 && wy < GRID_SIZE && isWalkable(grid, wx, wy)) {
          goblin.wanderTarget = { x: wx, y: wy };
          goblin.wanderExpiry = currentTick + WANDER_HOLD_TICKS;
          picked = true;
          break;
        }
      }
    }
    if (!picked) {
      const fallDirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
      const fallOpen = fallDirs
        .map(d => ({ x: goblin.x + d.x, y: goblin.y + d.y }))
        .filter(p => isWalkable(grid, p.x, p.y));
      if (fallOpen.length > 0) {
        const fb = fallOpen[Math.floor(Math.random() * fallOpen.length)];
        goblin.x = fb.x; goblin.y = fb.y;
      }
      goblin.task = 'wandering';
      return;
    }
  }

  if (!goblin.wanderTarget) { goblin.task = 'idle'; return; }
  const wanderNext = pathNextStep({ x: goblin.x, y: goblin.y }, goblin.wanderTarget, grid);
  goblin.x = wanderNext.x;
  goblin.y = wanderNext.y;
  goblin.task = 'exploring';
}
