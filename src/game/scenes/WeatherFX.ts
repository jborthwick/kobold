/**
 * Weather visual effects — camera-fixed particles + color tint overlays.
 *
 * Renders rain streaks, snowflakes, dust particles, and lightning flashes
 * on top of the game world. All purely cosmetic — doesn't affect simulation.
 *
 * Called every frame from WorldScene.update() for smooth animation.
 */

import type { WorldScene } from './WorldScene';
import type { WeatherType, Season } from '../../shared/types';

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

let seasonParticles: Particle[] = [];
let currentSeason: Season | null = null;

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
        spawn: (_w, h) => ({
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

// ── Season Particle configs ──────────────────────────────────────────────────

const SEASON_CONFIGS: Partial<Record<Season, WeatherConfig>> = {
    spring: {
        count: 35,
        color: 0xffbbdd,
        tintColor: 0x000000,
        tintAlpha: 0,
        spawn: (w, _h) => ({
            x: Math.random() * w,
            y: -10,
            speed: randRange(15, 30),
            alpha: randRange(0.4, 0.7),
            drift: randRange(-15, 15),
            size: randRange(2, 4),
        }),
        draw: () => { },
        step: (p, w, h, dt) => {
            p.y += p.speed * dt;
            p.x += (p.drift + Math.sin(p.y * 0.05) * 15) * dt;
            return p.y > h + 10 || p.x < -10 || p.x > w + 10;
        },
    },
    summer: {
        count: 45,
        color: 0xffffaa,
        tintColor: 0x000000,
        tintAlpha: 0,
        spawn: (w, h) => ({
            x: Math.random() * w,
            y: Math.random() * h,
            speed: randRange(-5, 5),
            alpha: randRange(0.3, 0.7),
            drift: randRange(-5, 5),
            size: randRange(1, 2.5),
        }),
        draw: () => { },
        step: (p, w, h, dt) => {
            p.y += (p.speed + Math.sin(p.x * 0.03) * 10) * dt;
            p.x += (p.drift + Math.cos(p.y * 0.03) * 10) * dt;
            p.alpha = Math.max(0.1, Math.min(0.8, p.alpha + (Math.random() - 0.5) * dt));
            return p.y > h + 10 || p.y < -10 || p.x < -10 || p.x > w + 10;
        },
    },
    autumn: {
        count: 40,
        color: 0xdd8822,
        tintColor: 0x000000,
        tintAlpha: 0,
        spawn: (w, _h) => ({
            x: Math.random() * w,
            y: -10,
            speed: randRange(30, 60),
            alpha: randRange(0.5, 0.9),
            drift: randRange(10, 30),
            size: randRange(2.5, 4.5),
        }),
        draw: () => { },
        step: (p, w, h, dt) => {
            p.y += p.speed * dt;
            p.x += (p.drift + Math.cos(p.y * 0.02) * 20) * dt;
            return p.y > h + 10 || p.x < -10 || p.x > w + 10;
        },
    },
    winter: {
        count: 25,
        color: 0xffffff,
        tintColor: 0x000000,
        tintAlpha: 0,
        spawn: (w, _h) => ({
            x: Math.random() * w,
            y: -10,
            speed: randRange(10, 25),
            alpha: randRange(0.2, 0.4),
            drift: randRange(-10, 10),
            size: randRange(1, 2),
        }),
        draw: () => { },
        step: (p, w, h, dt) => {
            p.y += p.speed * dt;
            p.x += (p.drift + Math.sin(p.y * 0.02) * 10) * dt;
            return p.y > h + 10 || p.x < -10 || p.x > w + 10;
        },
    },
};

// ── Public API ───────────────────────────────────────────────────────────────

export function initWeatherFX(scene: WorldScene) {
    scene.weatherTintGfx = scene.add.graphics().setScrollFactor(0).setDepth(199);
    scene.weatherGfx = scene.add.graphics().setScrollFactor(0).setDepth(200);
    particles = [];
    currentWeather = null;
    seasonParticles = [];
    currentSeason = null;
    flashAlpha = 0;
    flashCooldown = 0;
}

export function updateWeatherFX(scene: WorldScene, delta: number) {
    const weather = scene.weather.type;
    const cam = scene.cameras.main;
    const w = cam.width;
    const h = cam.height;
    const dt = scene.paused ? 0 : delta / 1000; // freeze particles when paused

    // scrollFactor(0) objects still get zoomed — divide by zoom to stay viewport-sized
    const z = cam.zoom;

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
        scene.weatherTintGfx.fillRect(0, 0, w / z, h / z);
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
            scene.weatherTintGfx.fillRect(0, 0, w / z, h / z);
            flashAlpha *= 0.85; // rapid decay
            if (flashAlpha < 0.02) flashAlpha = 0;
        }
    } else {
        flashAlpha = 0;
        flashCooldown = 0;
    }

    // ── Particles ───────────────────────────────────────────────────────
    scene.weatherGfx.clear();

    if (cfg && particles.length > 0) {
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
            // Draw at zoom-compensated coordinates so particles stay pixel-sized
            const pp = particles[i];
            const sx = pp.x / z, sy = pp.y / z, ss = pp.size / z;
            if (cfg === CONFIGS.rain || cfg === CONFIGS.storm) {
                const lw = cfg === CONFIGS.storm ? 1.5 / z : 1 / z;
                scene.weatherGfx.lineStyle(lw, cfg.color, pp.alpha);
                scene.weatherGfx.lineBetween(sx, sy, sx - ss * 0.3, sy + ss);
            } else if (cfg === CONFIGS.cold) {
                scene.weatherGfx.fillStyle(0xffffff, pp.alpha);
                scene.weatherGfx.fillCircle(sx, sy, ss);
            } else if (cfg === CONFIGS.drought) {
                scene.weatherGfx.fillStyle(0xbb9966, pp.alpha);
                scene.weatherGfx.fillRect(sx, sy, ss, ss * 0.6);
            }
        }
    }

    // ── Season Particles ────────────────────────────────────────────────
    const season = scene.weather.season;
    if (season !== currentSeason) {
        currentSeason = season;
        const sCfg = season ? SEASON_CONFIGS[season] : undefined;
        if (sCfg) {
            seasonParticles = [];
            for (let i = 0; i < sCfg.count; i++) {
                const sp = sCfg.spawn(w, h);
                sp.y = Math.random() * h;
                seasonParticles.push(sp);
            }
        } else {
            seasonParticles = [];
        }
    }

    const sCfg = season ? SEASON_CONFIGS[season] : undefined;
    if (sCfg && seasonParticles.length > 0) {
        for (let i = 0; i < seasonParticles.length; i++) {
            const p = seasonParticles[i];
            const needsRespawn = sCfg.step(p, w, h, dt);
            if (needsRespawn) {
                seasonParticles[i] = sCfg.spawn(w, h);
            }
            const pp = seasonParticles[i];
            const sx = pp.x / z, sy = pp.y / z, ss = pp.size / z;

            if (season === 'spring') {
                scene.weatherGfx.fillStyle(sCfg.color, pp.alpha);
                scene.weatherGfx.fillCircle(sx, sy, ss);
            } else if (season === 'summer') {
                scene.weatherGfx.fillStyle(sCfg.color, Math.max(0, pp.alpha));
                scene.weatherGfx.fillCircle(sx, sy, ss);
            } else if (season === 'autumn') {
                scene.weatherGfx.fillStyle(sCfg.color, pp.alpha);
                scene.weatherGfx.fillRect(sx, sy, ss, ss);
            } else if (season === 'winter') {
                scene.weatherGfx.fillStyle(sCfg.color, pp.alpha);
                scene.weatherGfx.fillCircle(sx, sy, ss);
            }
        }
    }
}
