import { SAVE_COMPAT_VERSION } from '../version';

export const CURRENT_SAVE_KEY = `kobold_save_c${SAVE_COMPAT_VERSION}`;

// Known legacy keys from before compatibility-window versioning.
export const LEGACY_SAVE_KEYS = ['kobold_save_v2'] as const;
const COMPAT_KEY_PREFIX = 'kobold_save_c';

export function getSaveString(): string | null {
  return localStorage.getItem(CURRENT_SAVE_KEY);
}

export function setSaveString(value: string): void {
  localStorage.setItem(CURRENT_SAVE_KEY, value);
}

export function removeCurrentSave(): void {
  localStorage.removeItem(CURRENT_SAVE_KEY);
}

/**
 * Prototype policy: if we don't have a compatible save but we do have a known legacy save,
 * remove the legacy save so players aren't stuck with a broken Continue button.
 */
export function pruneIncompatibleSave(): { removedKey: string | null } {
  if (localStorage.getItem(CURRENT_SAVE_KEY)) return { removedKey: null };

  // If there are other compatibility-window saves from older code, delete them.
  // This keeps iteration fast when SAVE_COMPAT_VERSION is bumped.
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (k !== CURRENT_SAVE_KEY && k.startsWith(COMPAT_KEY_PREFIX)) {
      localStorage.removeItem(k);
      return { removedKey: k };
    }
  }

  for (const k of LEGACY_SAVE_KEYS) {
    if (localStorage.getItem(k)) {
      localStorage.removeItem(k);
      return { removedKey: k };
    }
  }

  return { removedKey: null };
}

