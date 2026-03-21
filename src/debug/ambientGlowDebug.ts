/**
 * Warmth/danger ambient tuning — defaults ship in production; `GlowDebugPanel` (dev + desktop)
 * mutates `ambientGlowDebug` live. Phaser applies blend modes on bus events; WorldRender reads
 * numeric fields every `drawOverlay`.
 */

import * as Phaser from 'phaser';
import type { DayNightVisualStrength } from '../simulation/weather';

/** Phaser layer blend presets exposed in the glow debug panel. */
export type DebugGfxBlendMode = 'normal' | 'add' | 'screen' | 'multiply' | 'overlay';

export interface AmbientGlowDebugConfig {
  warmthPow: number;
  warmthMult: number;
  dangerPow: number;
  dangerMult: number;
  nightBoostPow: number;
  nightBoostBase: number;
  nightBoostScale: number;
  /** Night boost only when nightStrength exceeds this (0–1). */
  nightMinStrength: number;
  /** Warmth/danger `ambientGfx` blend (usually ADD). */
  blendMode: DebugGfxBlendMode;
  /** Full-screen weather + day/night grading (`weatherTintGfx`). */
  weatherTintBlendMode: DebugGfxBlendMode;
  /** Rain/snow/dust draw layer (`weatherGfx`). */
  weatherParticlesBlendMode: DebugGfxBlendMode;
  /** Food/material/wood/warmth tactical overlay (`overlayGfx`). */
  overlayTacticalBlendMode: DebugGfxBlendMode;
  /** Multiplier on `weatherTintGfx` alpha (whole layer). */
  weatherTintLayerAlpha: number;
  /**
   * Model peak α of night tint **if** it composites on top of `ambientGfx` (legacy depth 199).
   * With tint between floor and objects, ADD glow is not washed — default 0 (no boost).
   */
  overlayCompNightPeak: number;
  /** Same idea for dusk purple; default 0 with tint below objects. */
  overlayCompDuskPeak: number;
  /** How much dusk α counts toward estimated wash (0–1). */
  overlayCompDuskMix: number;
  /** Clamp estimated wash `t` before 1/(1−t) (avoids blow-up). */
  overlayCompMaxWash: number;
  /** Hard cap on the glow alpha multiplier. */
  overlayCompMaxScale: number;
  /**
   * On Hearth/Fire tiles only: scale base orange ADD warmth (neighbors unchanged).
   * Lower = keep pixel art readable while halo stays strong around the source.
   */
  sourceWarmthTileMult: number;
  /** On Hearth/Fire tiles only: scale the extra yellow night boost (usually lower than above). */
  sourceNightBoostTileMult: number;
}

export const AMBIENT_GLOW_DEBUG_DEFAULTS: AmbientGlowDebugConfig = {
  warmthPow: 1.85,
  warmthMult: 0.32,
  dangerPow: 1.85,
  dangerMult: 0.28,
  nightBoostPow: 1.45,
  nightBoostBase: 0.14,
  nightBoostScale: 0.26,
  nightMinStrength: 0.2,
  blendMode: 'add',
  weatherTintBlendMode: 'normal',
  weatherParticlesBlendMode: 'normal',
  overlayTacticalBlendMode: 'normal',
  weatherTintLayerAlpha: 1,
  overlayCompNightPeak: 0,
  overlayCompDuskPeak: 0,
  overlayCompDuskMix: 0.35,
  overlayCompMaxWash: 0.62,
  overlayCompMaxScale: 1,
  sourceWarmthTileMult: 0.52,
  sourceNightBoostTileMult: 0.22,
};

export const ambientGlowDebug: AmbientGlowDebugConfig = { ...AMBIENT_GLOW_DEBUG_DEFAULTS };

export function resetAmbientGlowDebug(): void {
  Object.assign(ambientGlowDebug, AMBIENT_GLOW_DEBUG_DEFAULTS);
}

/**
 * Multiplier for ADD warmth when the weather tint stacks **above** ambient (washes orange).
 * Tint is normally drawn between floor and object layers, so this stays ~1 unless you tune
 * `overlayComp*` for experiments or a future depth change.
 */
export function computeAmbientGlowOverlayCompensation(strengths: DayNightVisualStrength): number {
  const cfg = ambientGlowDebug;
  const nightA = cfg.overlayCompNightPeak * strengths.nightStrength;
  const duskA = cfg.overlayCompDuskPeak * strengths.duskStrength;
  const approxWash = nightA + duskA * cfg.overlayCompDuskMix;
  const t = Math.min(cfg.overlayCompMaxWash, Math.max(0, approxWash));
  const inv = 1 / (1 - t);
  return Math.min(cfg.overlayCompMaxScale, inv);
}

export function applyDebugGfxBlendMode(
  gfx: Phaser.GameObjects.Graphics,
  mode: DebugGfxBlendMode,
): void {
  switch (mode) {
    case 'normal':
      gfx.setBlendMode(Phaser.BlendModes.NORMAL);
      return;
    case 'add':
      gfx.setBlendMode(Phaser.BlendModes.ADD);
      return;
    case 'screen':
      gfx.setBlendMode(Phaser.BlendModes.SCREEN);
      return;
    case 'multiply':
      gfx.setBlendMode(Phaser.BlendModes.MULTIPLY);
      return;
    case 'overlay':
      gfx.setBlendMode(Phaser.BlendModes.OVERLAY);
      return;
    default: {
      const _exhaustive: never = mode;
      void _exhaustive;
      gfx.setBlendMode(Phaser.BlendModes.NORMAL);
    }
  }
}

/** Apply blend mode from debug config to the ambient warmth/danger graphics object. */
export function applyAmbientGfxBlendMode(gfx: Phaser.GameObjects.Graphics): void {
  applyDebugGfxBlendMode(gfx, ambientGlowDebug.blendMode);
}

export interface DebugRenderLayers {
  ambient: Phaser.GameObjects.Graphics;
  weatherTint: Phaser.GameObjects.Graphics;
  weatherGfx: Phaser.GameObjects.Graphics;
  overlayGfx: Phaser.GameObjects.Graphics;
}

/** Blend + alpha for all debug-tunable compositing layers (call on scene create + after panel edits). */
export function applyAllDebugRenderBlendModes(layers: DebugRenderLayers): void {
  const cfg = ambientGlowDebug;
  applyDebugGfxBlendMode(layers.ambient, cfg.blendMode);
  applyDebugGfxBlendMode(layers.weatherTint, cfg.weatherTintBlendMode);
  applyDebugGfxBlendMode(layers.weatherGfx, cfg.weatherParticlesBlendMode);
  applyDebugGfxBlendMode(layers.overlayGfx, cfg.overlayTacticalBlendMode);
  layers.weatherTint.setAlpha(cfg.weatherTintLayerAlpha);
}
