import type { RoomType } from './types';

export const ROOM_DIMS: Record<RoomType, { w: number; h: number }> = {
  storage: { w: 5, h: 5 },
  kitchen: { w: 5, h: 5 },
  lumber_hut: { w: 5, h: 5 },
  blacksmith: { w: 5, h: 5 },
  farm: { w: 10, h: 5 },
  nursery_pen: { w: 5, h: 5 },
} as const;

/**
 * Outdoor rooms are "designated zones" that should not be fortified with walls and do not
 * contribute to shelter/warmth calculations (they're outside by definition).
 */
export const OUTDOOR_ROOM_TYPES = new Set<RoomType>([
  'farm',
]);

export function getRoomDims(type: RoomType): { w: number; h: number } {
  return ROOM_DIMS[type];
}

export function isOutdoorRoomType(type: RoomType): boolean {
  return OUTDOOR_ROOM_TYPES.has(type);
}

