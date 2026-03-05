/**
 * Weather system — a global state that modifies growback rates and goblin metabolism.
 *
 * Weather creates cascading scarcity/abundance without touching any agent logic
 * directly.  Drought → growback drops → food dries up → hunger crisis → morale
 * spiral.  Rain → abundance → surplus → sharing → morale recovery.
 *
 * Seasons cycle every SEASON_LENGTH ticks.  Each season has a weighted distribution
 * of weather types.  Weather transitions happen at season boundaries and randomly
 * mid-season (WEATHER_SHIFT_CHANCE per tick).
 */

import type { WeatherType, Season } from '../shared/types';

// ── Types ────────────────────────────────────────────────────────────────────

export type { WeatherType, Season };

export interface Weather {
  type:     WeatherType;
  season:   Season;
  /** Tick at which we entered this season (for UI progress display). */
  seasonStart: number;
}

// ── Config ───────────────────────────────────────────────────────────────────

/** Ticks per season (~85 seconds at 7 tps). */
const SEASON_LENGTH = 600;

/** Per-tick chance of a mid-season weather shift. */
const WEATHER_SHIFT_CHANCE = 0.002;

/** Growback multipliers by weather type. */
const GROWBACK_MODS: Record<WeatherType, number> = {
  clear:   1.0,
  rain:    1.8,    // food grows almost twice as fast
  drought: 0.25,   // food barely regenerates
  cold:    0.5,    // slow growth
  storm:   2.5,    // torrential rain — fastest growback, offset by lightning risk
};

/** Metabolism multipliers by weather type. */
const METABOLISM_MODS: Record<WeatherType, number> = {
  clear:   1.0,
  rain:    1.0,
  drought: 1.0,
  cold:    1.4,    // burn calories faster in cold
  storm:   1.2,    // stressful conditions burn extra energy
};

/** Weighted weather distributions per season.
 *  Each array: [clear, rain, drought, cold, storm] weights (sum to 1). */
const SEASON_WEIGHTS: Record<Season, [number, number, number, number, number]> = {
  spring:  [0.25, 0.35, 0.05, 0.10, 0.25],  // stormy spring
  summer:  [0.40, 0.05, 0.35, 0.05, 0.15],  // summer thunderstorms
  autumn:  [0.35, 0.25, 0.10, 0.15, 0.15],  // mixed, moderate storms
  winter:  [0.15, 0.10, 0.05, 0.70, 0.00],  // cold dominates; no storms
};

const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter'];
const WEATHER_TYPES: WeatherType[] = ['clear', 'rain', 'drought', 'cold', 'storm'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function pickWeather(season: Season): WeatherType {
  const weights = SEASON_WEIGHTS[season];
  const roll = Math.random();
  let cumulative = 0;
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i];
    if (roll < cumulative) return WEATHER_TYPES[i];
  }
  return 'clear';
}

function nextSeason(current: Season): Season {
  const idx = SEASONS.indexOf(current);
  return SEASONS[(idx + 1) % SEASONS.length];
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Create the initial weather state. */
export function createWeather(tick: number): Weather {
  const season = SEASONS[0];
  return {
    type:        pickWeather(season),
    season,
    seasonStart: tick,
  };
}

/**
 * Advance the weather system by one tick.
 * Returns a log message if the weather or season changed, null otherwise.
 */
export function tickWeather(weather: Weather, tick: number): string | null {
  const ticksInSeason = tick - weather.seasonStart;

  // Season transition
  if (ticksInSeason >= SEASON_LENGTH) {
    const oldSeason = weather.season;
    weather.season      = nextSeason(oldSeason);
    weather.seasonStart = tick;
    weather.type        = pickWeather(weather.season);
    return `Season changed: ${oldSeason} → ${weather.season} (${weather.type})`;
  }

  // Random mid-season weather shift
  if (Math.random() < WEATHER_SHIFT_CHANCE) {
    const oldType = weather.type;
    weather.type = pickWeather(weather.season);
    if (weather.type !== oldType) {
      return `Weather shifted: ${oldType} → ${weather.type}`;
    }
  }

  return null;
}

/** Growback rate multiplier for the current weather. */
export function growbackModifier(weather: Weather): number {
  return GROWBACK_MODS[weather.type];
}

/** Metabolism multiplier for the current weather. */
export function metabolismModifier(weather: Weather): number {
  return METABOLISM_MODS[weather.type];
}

/** Ticks per season (exported for UI progress calculation). */
export const SEASON_LENGTH_TICKS = SEASON_LENGTH;

/** Display label for weather (for HUD). */
export function weatherLabel(weather: Weather): string {
  const icons: Record<WeatherType, string> = {
    clear: 'Clear', rain: 'Rain', drought: 'Drought', cold: 'Cold', storm: 'Storm ⚡',
  };
  const seasonIcons: Record<Season, string> = {
    spring: 'Spring', summer: 'Summer', autumn: 'Autumn', winter: 'Winter',
  };
  return `${seasonIcons[weather.season]} — ${icons[weather.type]}`;
}
