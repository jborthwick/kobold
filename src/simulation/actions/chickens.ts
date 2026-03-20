import type { Chicken, Room } from '../../shared/types';
import { moveToward } from './helpers';
import type { Action } from './types';

function isChickenInNurseryPen(chicken: Chicken, rooms: Room[] | undefined): boolean {
  if (!rooms) return false;
  return rooms.some(
    (room) =>
      room.type === 'nursery_pen' &&
      chicken.x >= room.x &&
      chicken.x < room.x + room.w &&
      chicken.y >= room.y &&
      chicken.y < room.y + room.h,
  );
}

function nearestFreeChicken(
  x: number,
  y: number,
  chickens: Chicken[] | undefined,
  rooms: Room[] | undefined,
): Chicken | null {
  if (!chickens || chickens.length === 0) return null;
  return chickens.reduce<Chicken | null>((best, chicken) => {
    if (chicken.heldByGoblinId) return best;
    if (isChickenInNurseryPen(chicken, rooms)) return best;
    const dist = Math.abs(chicken.x - x) + Math.abs(chicken.y - y);
    const bestDist = best ? Math.abs(best.x - x) + Math.abs(best.y - y) : Infinity;
    return dist < bestDist ? chicken : best;
  }, null);
}

function nearestNurseryRoom(x: number, y: number, rooms: Room[] | undefined): Room | null {
  if (!rooms || rooms.length === 0) return null;
  return rooms.reduce<Room | null>((best, room) => {
    if (room.type !== 'nursery_pen') return best;
    const cx = room.x + Math.floor(room.w / 2);
    const cy = room.y + Math.floor(room.h / 2);
    const dist = Math.abs(cx - x) + Math.abs(cy - y);
    if (!best) return room;
    const bx = best.x + Math.floor(best.w / 2);
    const by = best.y + Math.floor(best.h / 2);
    const bestDist = Math.abs(bx - x) + Math.abs(by - y);
    return dist < bestDist ? room : best;
  }, null);
}

function findDropTile(room: Room, fromX: number, fromY: number): { x: number; y: number } {
  let best = { x: room.x + Math.floor(room.w / 2), y: room.y + Math.floor(room.h / 2) };
  let bestDist = Infinity;
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      const dist = Math.abs(x - fromX) + Math.abs(y - fromY);
      if (dist < bestDist) {
        bestDist = dist;
        best = { x, y };
      }
    }
  }
  return best;
}

export const captureChicken: Action = {
  name: 'captureChicken',
  tags: ['work'],
  eligible: ({ goblin, rooms, chickens }) => {
    if (goblin.carryingChickenId) return false;
    if (!rooms?.some((r) => r.type === 'nursery_pen')) return false;
    return !!nearestFreeChicken(goblin.x, goblin.y, chickens, rooms);
  },
  score: ({ goblin, chickens, rooms, resourceBalance }) => {
    const target = nearestFreeChicken(goblin.x, goblin.y, chickens, rooms);
    if (!target) return 0;
    const dist = Math.abs(target.x - goblin.x) + Math.abs(target.y - goblin.y);
    const urgency = 0.3 + (resourceBalance?.consumablesPressure ?? 0) * 0.5;
    return Math.max(0.1, Math.min(1, urgency * (1 / Math.max(1, dist / 6))));
  },
  execute: ({ goblin, chickens, rooms, grid, currentTick }) => {
    const target = nearestFreeChicken(goblin.x, goblin.y, chickens, rooms);
    if (!target) {
      goblin.task = 'listening for clucks';
      return;
    }
    if (goblin.x === target.x && goblin.y === target.y) {
      goblin.carryingChickenId = target.id;
      target.heldByGoblinId = goblin.id;
      goblin.task = 'captured a chicken';
      return;
    }
    moveToward(goblin, { x: target.x, y: target.y }, grid, currentTick);
    goblin.task = 'chasing chicken';
  },
};

export const depositChicken: Action = {
  name: 'depositChicken',
  tags: ['work'],
  eligible: ({ goblin, rooms, chickens }) => {
    if (!goblin.carryingChickenId) return false;
    if (!rooms?.some((r) => r.type === 'nursery_pen')) return false;
    return !!chickens?.some((c) => c.id === goblin.carryingChickenId);
  },
  score: ({ goblin }) => (goblin.carryingChickenId ? 0.95 : 0),
  execute: ({ goblin, rooms, chickens, grid, currentTick }) => {
    const carriedId = goblin.carryingChickenId;
    if (!carriedId || !chickens) return;
    const chicken = chickens.find((c) => c.id === carriedId);
    if (!chicken) {
      goblin.carryingChickenId = undefined;
      return;
    }
    const room = nearestNurseryRoom(goblin.x, goblin.y, rooms);
    if (!room) {
      goblin.task = 'holding chicken';
      return;
    }
    const drop = findDropTile(room, goblin.x, goblin.y);
    if (goblin.x === drop.x && goblin.y === drop.y) {
      chicken.heldByGoblinId = undefined;
      chicken.homePenId = room.id;
      chicken.x = goblin.x;
      chicken.y = goblin.y;
      goblin.carryingChickenId = undefined;
      goblin.task = 'deposited chicken';
      return;
    }
    moveToward(goblin, drop, grid, currentTick);
    goblin.task = '→ nursery pen';
  },
};
