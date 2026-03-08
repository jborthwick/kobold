import { GRID_SIZE } from '../../shared/constants';
import { bus } from '../../shared/events';
import { getActiveFaction } from '../../shared/factions';

import { tickWeather, growbackModifier, metabolismModifier } from '../../simulation/weather';
import { findHearths, computeWarmth, computeDanger, updateTraffic } from '../../simulation/diffusion';
import { tickAgentUtility } from '../../simulation/utilityAI';
import { SUCCESSION_DELAY, spawnSuccessor } from '../../simulation/agents';
import { growback } from '../../simulation/world';
import { tickBurningGoblins, tickFire } from '../../simulation/fire';
import { tickPooling } from '../../simulation/pooling';
import { tickLightning } from '../../simulation/lightning';
import { maybeSpawnRaid, tickAdventurers } from '../../simulation/adventurers';
import { addMemory } from '../../simulation/mood';
import { rollWound, woundLabel } from '../../simulation/wounds';
import { tickWorldEvents, tickMushroomSprout } from '../../simulation/events';
import { expandStockpilesInRooms } from '../../simulation/rooms';
import { saveGame } from '../../shared/save';
import * as WorldGoals from './WorldGoals';
import { emitGameState, emitMiniMap, buildSaveData } from './WorldState';
import type { WorldScene } from './WorldScene';

export function gameTick(scene: WorldScene) {
    scene.tick++;

    // ── Weather tick ─────────────────────────────────────────────────────
    const weatherMsg = tickWeather(scene.weather, scene.tick);
    if (weatherMsg) {
        bus.emit('logEntry', {
            tick: scene.tick,
            goblinId: 'system',
            goblinName: 'WEATHER',
            message: weatherMsg,
            level: 'info',
        });
    }

    // ── Diffusion fields ─────────────────────────────────────────────────
    const hearths = findHearths(scene.grid);
    computeWarmth(scene.grid, hearths, scene.foodStockpiles, scene.weather.type, scene.warmthField);
    computeDanger(scene.grid, scene.adventurers, scene.dangerFieldPrev, scene.dangerField);
    scene.dangerFieldPrev.set(scene.dangerField);
    updateTraffic(scene.grid, scene.goblins);

    // Cache warmth on each goblin — smoothed (90% old / 10% new) so the bar decays gradually
    // as goblins walk away from a hearth (~10 ticks to feel it) rather than snapping to 0
    // the moment they step outside the 8-tile warmth radius.
    for (const d of scene.goblins) {
        if (d.alive) {
            const raw = scene.warmthField[d.y * GRID_SIZE + d.x];
            d.warmth = (d.warmth ?? raw) * 0.95 + raw * 0.05;
        }
    }

    const aliveBeforeTick = new Set(scene.goblins.filter(g => g.alive).map(g => g.id));

    for (const d of scene.goblins) {
        tickAgentUtility(
            d, scene.grid, scene.tick, scene.goblins,
            (message, level) => {
                bus.emit('logEntry', {
                    tick: scene.tick,
                    goblinId: d.id,
                    goblinName: d.name,
                    message,
                    level,
                });
            },
            scene.foodStockpiles, scene.adventurers, scene.oreStockpiles,
            scene.colonyGoal ?? undefined, scene.woodStockpiles,
            metabolismModifier(scene.weather), scene.warmthField, scene.dangerField,
            scene.weather.type, scene.rooms, scene.mealStockpiles
        );
    }

    growback(scene.grid, growbackModifier(scene.weather), scene.tick);
    tickBurningGoblins(scene.grid, scene.tick, scene.goblins, (msg, level) => {
        bus.emit('logEntry', { tick: scene.tick, goblinId: 'world', goblinName: 'FIRE', message: msg, level });
    });
    tickPooling(scene.grid, scene.tick, scene.weather.type);
    tickFire(scene.grid, scene.tick, scene.goblins, scene.weather.type, (msg, level) => {
        bus.emit('logEntry', { tick: scene.tick, goblinId: 'world', goblinName: 'FIRE', message: msg, level });
    });
    tickLightning(scene.grid, scene.tick, scene.weather.type, (msg, level) => {
        bus.emit('logEntry', { tick: scene.tick, goblinId: 'world', goblinName: 'STORM', message: msg, level });
    });

    // ── Adventurer raids ───────────────────────────────────────────────────────
    const raid = maybeSpawnRaid(scene.grid, scene.goblins, scene.tick);
    if (raid) {
        scene.adventurers.push(...raid.adventurers);
        bus.emit('logEntry', {
            tick: scene.tick,
            goblinId: 'adventurer',
            goblinName: 'RAID',
            message: `⚔ ${raid.count} ${getActiveFaction().enemyNounPlural} storm from the ${raid.edge} !${getActiveFaction().raidSuffix} `,
            level: 'error',
        });
    }

    if (scene.adventurers.length > 0) {
        const gr = tickAdventurers(scene.adventurers, scene.goblins, scene.grid, scene.tick);

        // Apply damage to targeted goblins
        for (const { goblinId, damage } of gr.attacks) {
            const d = scene.goblins.find(dw => dw.id === goblinId);
            if (d && d.alive) {
                d.health = Math.max(0, d.health - damage);
                addMemory(d, 'attacked_by_enemy', scene.tick);
                const enemyNoun = getActiveFaction().enemyNounPlural;
                if (d.health <= 0) {
                    d.alive = false;
                    d.task = 'dead';
                    d.causeOfDeath = `killed by ${enemyNoun}`;
                    bus.emit('logEntry', {
                        tick: scene.tick,
                        goblinId: d.id,
                        goblinName: d.name,
                        message: `killed by ${enemyNoun}!`,
                        level: 'error',
                    });
                } else {
                    const enemySing = enemyNoun.replace(/s$/, '');
                    // Survived — stack HISTORY memories
                    const lastMem = d.memory[d.memory.length - 1];
                    if (lastMem && lastMem.crisis === 'combat' && lastMem.action.startsWith(`hit by ${enemySing}`)) {
                        lastMem.tick = scene.tick;
                        const match = lastMem.action.match(/x(\d+)/);
                        const count = match ? parseInt(match[1], 10) + 1 : 2;
                        lastMem.action = `hit by ${enemySing} x${count}`;
                    } else {
                        d.memory.push({ tick: scene.tick, crisis: 'combat', action: `hit by ${enemySing}` });
                    }
                    
                    const hits = (scene.combatHits.get(d.id) ?? 0) + 1;
                    scene.combatHits.set(d.id, hits);
                    if (hits % 3 === 1) {  // log 1st hit, then every 3rd
                        bus.emit('logEntry', {
                            tick: scene.tick,
                            goblinId: d.id,
                            goblinName: d.name,
                            message: hits === 1
                                ? `⚔ hit by ${enemySing} !(${d.health.toFixed(0)} hp)`
                                : `⚔ fighting ${enemySing} (${hits} hits taken, ${d.health.toFixed(0)} hp)`,
                            level: 'warn',
                        });
                    }
                    // Wound roll — 60% chance of injury per hit (if not already wounded)
                    const w = rollWound(d, scene.tick);
                    if (w) {
                        d.wound = w;
                        bus.emit('logEntry', {
                            tick: scene.tick,
                            goblinId: d.id,
                            goblinName: d.name,
                            message: `🩹 suffered a ${woundLabel(w.type)} !`,
                            level: 'warn',
                        });
                    }
                }
            }
        }

        // Emit adventurer action log entries
        for (const { message, level } of gr.logs) {
            bus.emit('logEntry', {
                tick: scene.tick,
                goblinId: 'adventurer',
                goblinName: 'GOBLIN',
                message,
                level,
            });
        }

        // Remove dead adventurers and their sprites
        if (gr.adventurerDeaths.length > 0) {
            const deadIds = new Set(gr.adventurerDeaths);
            scene.adventurers = scene.adventurers.filter(g => !deadIds.has(g.id));
            scene.adventurerKillCount += gr.adventurerDeaths.length;
            for (const id of gr.adventurerDeaths) {
                const spr = scene.adventurerSprites.get(id);
                if (spr) { spr.destroy(); scene.adventurerSprites.delete(id); }
            }
            // Add kill memory to the goblins that scored the kill
            for (const { goblinId } of gr.kills) {
                const killer = scene.goblins.find(dw => dw.id === goblinId && dw.alive);
                if (killer) {
                    killer.adventurerKills += 1;
                    const factionCfg = getActiveFaction();
                    const killVerb = factionCfg.killVerb;
                    const enemySing = factionCfg.enemyNounPlural.replace(/s$/, '');
                    const article = /^[aeiou]/i.test(enemySing) ? 'an' : 'a';
                    killer.memory.push({ tick: scene.tick, crisis: 'combat', action: `${killVerb} ${article} ${enemySing} in battle` });
                    const hitsTaken = scene.combatHits.get(killer.id) ?? 0;
                    scene.combatHits.delete(killer.id);
                    bus.emit('logEntry', {
                        tick: scene.tick,
                        goblinId: killer.id,
                        goblinName: killer.name,
                        message: hitsTaken > 0
                            ? `⚔ ${killVerb} ${article} ${enemySing} !(took ${hitsTaken} hits, ${killer.health.toFixed(0)} hp)`
                            : `⚔ ${killVerb} ${article} ${enemySing} !`,
                        level: 'warn',
                    });
                }
            }
        }
    }

    // World events — tension-aware storyteller biases event selection
    const ev = tickWorldEvents(scene.grid, scene.tick, scene.goblins, scene.adventurers);
    if (ev.fired) {
        bus.emit('logEntry', {
            tick: scene.tick,
            goblinId: 'world',
            goblinName: 'WORLD',
            message: ev.message,
            level: 'warn',
        });
    }

    // Small steady mushroom sprouting — every 150 ticks, a fresh 1–4 tile patch
    // (no log — too routine, clutters the event feed)
    tickMushroomSprout(scene.grid, scene.tick);

    // ── Check for any deaths this tick to queue successions ────────────────
    for (const id of aliveBeforeTick) {
        const g = scene.goblins.find(d => d.id === id);
        if (g && !g.alive) {
            scene.pendingSuccessions.push({ deadGoblinId: g.id, spawnAtTick: scene.tick + SUCCESSION_DELAY });
        }
    }

    // ── Succession — spawn queued replacements ──────────────────────────────
    for (let i = scene.pendingSuccessions.length - 1; i >= 0; i--) {
        const s = scene.pendingSuccessions[i];
        if (scene.tick < s.spawnAtTick) continue;
        scene.pendingSuccessions.splice(i, 1);

        const dead = scene.goblins.find(d => d.id === s.deadGoblinId);
        if (!dead) continue;

        const successor = spawnSuccessor(dead, scene.grid, scene.spawnZone, scene.goblins, scene.tick);
        const depotCenter = scene.foodStockpiles[0]
            ?? { x: Math.floor(scene.spawnZone.x + scene.spawnZone.w / 2), y: Math.floor(scene.spawnZone.y + scene.spawnZone.h / 2) };
        successor.homeTile = { x: depotCenter.x, y: depotCenter.y };
        scene.goblins.push(successor);

        bus.emit('logEntry', {
            tick: scene.tick,
            goblinId: successor.id,
            goblinName: successor.name,
            message: `arrives to take ${dead.name} 's place. [${successor.role.toUpperCase()}]`,
            level: 'info',
        });

        const thought = `I heard what happened to ${dead.name}. I will not make the same mistakes.`;
        successor.memory.push({ tick: scene.tick, crisis: 'arrival', action: `arrived to replace ${dead.name}`, reasoning: thought });
    }

    // ── Sync stockpile graphics (actions may have added new stockpiles) ─────
    while (scene.foodStockpileGfxList.length < scene.foodStockpiles.length) {
        scene.addFoodStockpileGraphics(scene.foodStockpiles[scene.foodStockpileGfxList.length]);
    }
    while (scene.mealStockpileGfxList.length < scene.mealStockpiles.length) {
        scene.addMealStockpileGraphics(scene.mealStockpiles[scene.mealStockpileGfxList.length]);
    }
    while (scene.oreStockpileGfxList.length < scene.oreStockpiles.length) {
        scene.addOreStockpileGraphics(scene.oreStockpiles[scene.oreStockpileGfxList.length]);
    }
    while (scene.woodStockpileGfxList.length < scene.woodStockpiles.length) {
        scene.addWoodStockpileGraphics(scene.woodStockpiles[scene.woodStockpileGfxList.length]);
    }

    // ── Storage expansion — new stockpile within owning room when last fills ──
    expandStockpilesInRooms(
        scene.grid,
        scene.rooms,
        scene.foodStockpiles,
        scene.oreStockpiles,
        scene.woodStockpiles,
        (pile) => scene.addFoodStockpileGraphics(pile),
        (pile) => scene.addOreStockpileGraphics(pile),
        (pile) => scene.addWoodStockpileGraphics(pile)
    );

    scene.terrainDirty = true;

    // Clear flag once all commanded goblins have arrived
    if (scene.commandTile) {
        const anyPending = scene.goblins.some(d => d.alive && d.commandTarget !== null);
        if (!anyPending) {
            scene.commandTile = null;
            scene.flagGfx.clear();
        }
    }

    WorldGoals.updateGoalProgress(scene);

    if (scene.tick % 5 === 0) emitMiniMap(scene);
    emitGameState(scene);

    // Auto-save every 300 ticks (~45 s at default speed)
    if (scene.tick % 100 === 0) saveGame(buildSaveData(scene));
}
