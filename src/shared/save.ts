/**
 * Persist full game state to localStorage (compatibility-keyed).
 * WorldTick auto-saves; StartMenu/WorldInit load via loadGame().
 */

export type { SaveData } from './save/types';
export { pruneIncompatibleSave } from './save/storage';

import type { SaveData } from './save/types';
import { migrateSaveData } from './save/migrations';
import { getSaveString, removeCurrentSave, setSaveString } from './save/storage';

/** Write full game state to localStorage. On quota exceeded, clears and retries once. */
export function saveGame(data: SaveData): void {
  try {
    setSaveString(JSON.stringify(data));
  } catch (e) {
    if ((e as Error).name === 'QuotaExceededError') {
      console.warn('localStorage quota exceeded; clearing old save and retrying...');
      removeCurrentSave();
      setSaveString(JSON.stringify(data));
      return;
    }
    throw e;
  }
}

/** Parse and migrate from localStorage; returns null if missing/invalid. */
export function loadGame(): SaveData | null {
  const s = getSaveString();
  if (!s) return null;
  try {
    const data = JSON.parse(s) as SaveData;
    return migrateSaveData(data);
  } catch {
    return null;
  }
}

/** Remove the save (e.g. new colony). */
export function deleteSave(): void {
  removeCurrentSave();
}

/** True if a save exists (start menu Continue button). */
export function hasSave(): boolean {
  return !!getSaveString();
}

/** Read save metadata — used for the start menu display. */
export function peekSave(): { tick: number; aliveGoblins: number } | null {
  const save = loadGame();
  if (!save) return null;
  return { tick: save.tick, aliveGoblins: save.goblins.filter(d => d.alive).length };
}
