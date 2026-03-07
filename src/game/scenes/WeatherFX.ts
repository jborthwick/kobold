/**
 * Weather visual effects — camera-fixed particles + color tint overlays.
 *
 * Renders rain streaks, snowflakes, dust particles, and lightning flashes
 * on top of the game world. All purely cosmetic — doesn't affect simulation.
 *
 * Called every frame from WorldScene.update() for smooth animation.
 */

import type { WorldScene } from './WorldScene';
import type { WeatherType } from '../../shared/types';

// ── Particle pool ────────────────────────────────────────────────────────────

interface Particle {
    x: number;
    y: number;
    speed: number;
    alpha: number;
    /** Horizontal drift (snow/dust) */
    drift: number;
    /** Length of rain streak or radius of snowflake/dust */
    size: number;
}

let particles: Particle[] = [];
let currentWeather: WeatherType | null = null;

// Lightning flash state
let flashAlpha = 0;
let flashCooldown = 0;

// ── Particle configs per weather type ────────────────────────────────────────

interface WeatherConfig {
    count: number;
    color: number;
    tintColor: number;
    tintAlpha: number;
    /** Create a single particle within viewport bounds */
    spawn: (w: number, h: number) => Particle;
    /** Draw one particle */
    draw: (gfx: Phaser.GameObjects.Graphics, p: Particle) => void;
    /** Update particle position; return true if needs respawn */
    step: (p: Particle, w: number, h: number, dt: number) => boolean;
}

function randRange(min: number, max: number) {
    return min + Math.random() * (max - min);
}

const CONFIGS: Partial<Record<WeatherType, WeatherConfig>> = {
    rain: {
        count: 150,
        color: 0x88bbff,
        tintColor: 0x2244aa,
        tintAlpha: 0.06,
        spawn: (w, h) => ({
            x: Math.random() * (w + 60) - 30,
            y: Math.random() * h,
            speed: randRange(400, 700),
            alpha: randRange(0.15, 0.4),
            drift: -80,
            size: randRange(8, 16),
        }),
        draw: (gfx, p) => {
            gfx.lineStyle(1, 0x88bbff, p.alpha);
            // Diagonal rain streak
            gfx.lineBetween(p.x, p.y, p.x - p.size * 0.3, p.y + p.size);
        },
        step: (p, _w, h, dt) => {
            p.y += p.speed * dt;
            p.x += p.drift * dt;
            return p.y > h + 20;
        },
    },

    cold: {
        count: 50,
        color: 0xffffff,
        tintColor: 0x4466aa,
        tintAlpha: 0.08,
        spawn: (w, h) => ({
            x: Math.random() * w,
            y: Math.random() * h,
            speed: randRange(20, 60),
            alpha: randRange(0.3, 0.7),
            drift: randRange(-15, 15),
            size: randRange(1.5, 3),
        }),
        draw: (gfx, p) => {
            gfx.fillStyle(0xffffff, p.alpha);
            gfx.fillCircle(p.x, p.y, p.size);
        },
        step: (p, w, h, dt) => {
            p.y += p.speed * dt;
            p.x += (p.drift + Math.sin(p.y * 0.02) * 30) * dt;
            return p.y > h + 10 || p.x < -10 || p.x > w + 10;
        },
    },

    drought: {
        count: 35,
        color: 0xbb9966,
        tintColor: 0xcc8844,
        tintAlpha: 0.04,
        spawn: (w, h) => ({
            x: -10,
            y: Math.random() * h,
            speed: randRange(40, 90),
            alpha: randRange(0.1, 0.3),
            drift: randRange(-5, 5),
            size: randRange(1.5, 3),
        }),
        draw: (gfx, p) => {
            gfx.fillStyle(0xbb9966, p.alpha);
            gfx.fillRect(p.x, p.y, p.size, p.size * 0.6);
        },
        step: (p, w, _h, dt) => {
            p.x += p.speed * dt;
            p.y += (p.drift + Math.sin(p.x * 0.01) * 20) * dt;
            return p.x > w + 10;
        },
    },

    storm: {
        count: 220,
        color: 0xaaccff,
        tintColor: 0x1a2a44,
        tintAlpha: 0.14,
        spawn: (w, h) => ({
            x: Math.random() * (w + 100) - 50,
            y: Math.random() * h,
            speed: randRange(600, 1000),
            alpha: randRange(0.2, 0.5),
            drift: -120,
            size: randRange(10, 22),
        }),
        draw: (gfx, p) => {
            gfx.lineStyle(1.5, 0xaaccff, p.alpha);
            gfx.lineBetween(p.x, p.y, p.x - p.size * 0.4, p.y + p.size);
        },
        step: (p, _w, h, dt) => {
            p.y += p.speed * dt;
            p.x += p.drift * dt;
            return p.y > h + 30;
        },
    },
};

// ── Public API ───────────────────────────────────────────────────────────────

export function initWeatherFX(scene: WorldScene) {
    scene.weatherTintGfx = scene.add.graphics().setScrollFactor(0).setDepth(199);
    scene.weatherGfx = scene.add.graphics().setScrollFactor(0).setDepth(200);
    particles = [];
    currentWeather = null;
    flashAlpha = 0;
    flashCooldown = 0;
}

export function updateWeatherFX(scene: WorldScene, delta: number) {
    const weather = scene.weather.type;
    const cam = scene.cameras.main;
    const w = cam.width;
    const h = cam.height;
    const dt = scene.paused ? 0 : delta / 1000; // freeze particles when paused

    // ── Weather changed — rebuild particle pool ─────────────────────────
    if (weather !== currentWeather) {
        currentWeather = weather;
        const cfg = CONFIGS[weather];
        if (cfg) {
            particles = [];
            for (let i = 0; i < cfg.count; i++) {
                particles.push(cfg.spawn(w, h));
            }
        } else {
            particles = [];
        }
        flashAlpha = 0;
    }

    const cfg = CONFIGS[weather];

    // ── Tint overlay ────────────────────────────────────────────────────
    scene.weatherTintGfx.clear();
    if (cfg) {
        scene.weatherTintGfx.fillStyle(cfg.tintColor, cfg.tintAlpha);
        scene.weatherTintGfx.fillRect(0, 0, w, h);
    }

    // ── Lightning flash (storm only) ────────────────────────────────────
    if (weather === 'storm') {
        flashCooldown -= dt;
        if (flashCooldown <= 0 && Math.random() < 0.003) {
            flashAlpha = randRange(0.3, 0.6);
            flashCooldown = randRange(2, 8); // seconds between flashes
        }
        if (flashAlpha > 0) {
            scene.weatherTintGfx.fillStyle(0xffffff, flashAlpha);
            scene.weatherTintGfx.fillRect(0, 0, w, h);
            flashAlpha *= 0.85; // rapid decay
            if (flashAlpha < 0.02) flashAlpha = 0;
        }
    } else {
        flashAlpha = 0;
        flashCooldown = 0;
    }

    // ── Particles ───────────────────────────────────────────────────────
    scene.weatherGfx.clear();
    if (!cfg || particles.length === 0) return;

    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const needsRespawn = cfg.step(p, w, h, dt);
        if (needsRespawn) {
            particles[i] = cfg.spawn(w, h);
            // Reset to top/edge for continuous flow
            const fresh = particles[i];
            if (weather === 'drought') {
                fresh.x = -10;
            } else {
                fresh.y = -10;
                fresh.x = Math.random() * (w + 60) - 30;
            }
        }
        cfg.draw(scene.weatherGfx, particles[i]);
    }
}
