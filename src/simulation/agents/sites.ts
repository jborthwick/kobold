/**
 * Resource site memory: constants and recordSite for goblin-known food/ore/wood patches.
 * See: FORAGEABLE_TILES, SITE_RECORD_THRESHOLD, PATCH_MERGE_RADIUS, recordSite.
 */

import { TileType, type ResourceSite } from '../../shared/types';

/** Min tile value worth storing in a goblin's site memory. */
export const SITE_RECORD_THRESHOLD = 3;
/** Max remembered sites per type per goblin. */
export const MAX_KNOWN_SITES = 5;
/**
 * Manhattan radius within which two tiles are treated as the same patch.
 * Prevents a cluster of 10 adjacent mushrooms from burning all 5 memory
 * slots on individual tiles from the same group.
 */
export const PATCH_MERGE_RADIUS = 4;

/**
 * Upsert a resource site into a goblin's memory list.
 * 1. Exact tile already known → refresh value + tick in place.
 * 2. Within PATCH_MERGE_RADIUS of an existing entry → same patch; upgrade
 *    the representative to the richer tile or just refresh its tick.
 * 3. New distinct patch → append, evicting the weakest entry when full.
 *
 * Only forageable/minable tiles should be passed in — callers are
 * responsible for filtering by FORAGEABLE_TILES or materialValue > 0
 * before calling, so non-harvestable tiles (Forest, Stone, etc.) are
 * never stored.
 */
export function recordSite(sites: ResourceSite[], x: number, y: number, value: number, tick: number): void {
  const idx = sites.findIndex(s => s.x === x && s.y === y);
  if (idx >= 0) { sites[idx] = { x, y, value, tick }; return; }

  const nearIdx = sites.findIndex(
    s => Math.abs(s.x - x) + Math.abs(s.y - y) <= PATCH_MERGE_RADIUS,
  );
  if (nearIdx >= 0) {
    if (value > sites[nearIdx].value) {
      sites[nearIdx] = { x, y, value, tick };
    } else {
      sites[nearIdx] = { ...sites[nearIdx], tick };
    }
    return;
  }

  if (sites.length < MAX_KNOWN_SITES) { sites.push({ x, y, value, tick }); return; }
  const weakIdx = sites.reduce((min, s, i) => s.value < sites[min].value ? i : min, 0);
  if (value > sites[weakIdx].value) sites[weakIdx] = { x, y, value, tick };
}

/** Tile types goblins can harvest food from. Add entries here to unlock new food sources. */
export const FORAGEABLE_TILES = new Set<TileType>([
  TileType.Mushroom,
]);
