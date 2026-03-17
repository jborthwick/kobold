import type { SaveData } from './types';

export function migrateSaveData(data: SaveData): SaveData {
  // Maximum iteration speed: we don't maintain long-lived migrations.
  // If the save isn't from the current code/compat window, it should be pruned instead.
  return data;
}

