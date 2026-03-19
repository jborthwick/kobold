import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Goblin, Room, Tile } from '../../shared/types';
import { TileType } from '../../shared/types';
import { GRID_SIZE } from '../../shared/constants';
import { fortifiableRoomWallSlots, fortifiableRooms } from '../agents/fort';
import * as pathfinding from '../agents/pathfinding';
import { buildWoodWall } from './building';
import { pickReachableWallSlot } from './wallJobs';

function dirtTile(): Tile {
  return {
    type: TileType.Dirt,
    foodValue: 0,
    maxFood: 0,
    materialValue: 0,
    maxMaterial: 0,
    growbackRate: 0,
  };
}

function emptyDirtGrid(): Tile[][] {
  const d = dirtTile();
  const grid: Tile[][] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    grid[y] = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      grid[y][x] = { ...d };
    }
  }
  return grid;
}

function minimalGoblin(overrides: Partial<Goblin> & Pick<Goblin, 'x' | 'y' | 'id'>): Goblin {
  return {
    id: overrides.id,
    name: 'Test',
    baseName: 'Test',
    generation: 1,
    x: overrides.x,
    y: overrides.y,
    health: 100,
    maxHealth: 100,
    hunger: 20,
    metabolism: 0.2,
    vision: 6,
    inventory: { food: 0, meals: 0, ore: 0, wood: 0 },
    morale: 50,
    alive: true,
    task: 'idle',
    commandTarget: null,
    memory: [],
    thoughts: [],
    memories: [],
    relations: {},
    trait: 'helpful',
    bio: '',
    goal: '',
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
    lastLoggedTicks: {},
    skills: { forage: 0, mine: 0, chop: 0, combat: 0, scout: 0, cook: 0, saw: 0, smith: 0 },
    ...overrides,
  };
}

describe('fortifiable rooms / wall slots', () => {
  it('excludes farm from fortifiableRooms', () => {
    const rooms: Room[] = [
      { id: 'f', type: 'farm', x: 10, y: 10, w: 10, h: 5 },
      { id: 'k', type: 'kitchen', x: 30, y: 30, w: 5, h: 5 },
    ];
    const f = fortifiableRooms(rooms);
    expect(f).toHaveLength(1);
    expect(f[0].type).toBe('kitchen');
  });

  it('produces no wall slots when only outdoor farm rooms exist', () => {
    const grid = emptyDirtGrid();
    const rooms: Room[] = [{ id: 'f', type: 'farm', x: 20, y: 20, w: 10, h: 5 }];
    const goblin = minimalGoblin({ id: 'g1', x: 25, y: 22 });
    const slots = fortifiableRoomWallSlots(rooms, grid, [goblin], 'g1', []);
    expect(slots).toHaveLength(0);
  });
});

describe('buildWoodWall', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is not eligible when only a farm room exists (planks available)', () => {
    const grid = emptyDirtGrid();
    const goblin = minimalGoblin({ id: 'g1', x: 25, y: 22 });
    const rooms: Room[] = [{ id: 'f', type: 'farm', x: 20, y: 20, w: 10, h: 5 }];
    const ok = buildWoodWall.eligible({
      goblin,
      grid,
      currentTick: 1,
      rooms,
      goblins: [goblin],
      plankStockpiles: [{ x: 1, y: 1, planks: 10, maxPlanks: 100 }],
    });
    expect(ok).toBe(false);
  });

  it('scores 0 when only farm rooms exist', () => {
    const grid = emptyDirtGrid();
    const goblin = minimalGoblin({ id: 'g1', x: 25, y: 22 });
    const rooms: Room[] = [{ id: 'f', type: 'farm', x: 20, y: 20, w: 10, h: 5 }];
    const s = buildWoodWall.score({
      goblin,
      grid,
      currentTick: 1,
      rooms,
      goblins: [goblin],
      plankStockpiles: [{ x: 1, y: 1, planks: 10, maxPlanks: 100 }],
    });
    expect(s).toBe(0);
  });

  it('is eligible with kitchen, planks, and reachable perimeter slot', () => {
    const grid = emptyDirtGrid();
    const rooms: Room[] = [{ id: 'k', type: 'kitchen', x: 22, y: 22, w: 5, h: 5 }];
    const goblin = minimalGoblin({ id: 'g1', x: 24, y: 24 });
    const ok = buildWoodWall.eligible({
      goblin,
      grid,
      currentTick: 1,
      rooms,
      goblins: [goblin],
      plankStockpiles: [{ x: 1, y: 1, planks: 10, maxPlanks: 100 }],
    });
    expect(ok).toBe(true);
  });
});

describe('pickReachableWallSlot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when path never advances and clears moveTarget pressure via cooldown keys', () => {
    const grid = emptyDirtGrid();
    const rooms: Room[] = [{ id: 'k', type: 'kitchen', x: 22, y: 22, w: 5, h: 5 }];
    const goblin = minimalGoblin({ id: 'g1', x: 24, y: 24 });
    const slots = fortifiableRoomWallSlots(rooms, grid, [goblin], 'g1', []);

    vi.spyOn(pathfinding, 'pathNextStep').mockImplementation((from) => ({ x: from.x, y: from.y }));

    const job = pickReachableWallSlot(goblin, grid, slots, 15, 100, 0);
    expect(job).toBe(null);
    const blockedKeys = Object.keys(goblin.lastLoggedTicks).filter(k => k.startsWith('wallBlk:'));
    expect(blockedKeys.length).toBeGreaterThan(0);
  });
});
