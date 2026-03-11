import { bus } from '../../shared/events';
import { getNextEventTick } from '../../simulation/events';
import { TILE_SIZE } from '../../shared/constants';
import type { SaveData } from '../../shared/save';
import type { MiniMapData } from '../../shared/types';
import type { WorldScene } from './WorldScene';

/** Serialise the full simulation state into a plain object suitable for JSON. */
export function buildSaveData(scene: WorldScene): SaveData {
    return {
        version: 2,
        tick: scene.tick,
        grid: scene.grid,
        goblins: scene.goblins.map(d => ({ ...d })),
        adventurers: scene.adventurers.map(g => ({ ...g })),
        colonyGoal: { ...scene.colonyGoal },
        foodStockpiles: scene.foodStockpiles.map(s => ({ ...s })),
        mealStockpiles: scene.mealStockpiles.map(s => ({ ...s })),
        oreStockpiles: scene.oreStockpiles.map(s => ({ ...s })),
        woodStockpiles: scene.woodStockpiles.map(s => ({ ...s })),
        plankStockpiles: scene.plankStockpiles.map(s => ({ ...s })),
        barStockpiles: scene.barStockpiles.map(s => ({ ...s })),
        adventurerKillCount: scene.adventurerKillCount,
        mealsCooked: scene.mealsCooked,
        spawnZone: { ...scene.spawnZone },
        pendingSuccessions: scene.pendingSuccessions.map(s => ({ ...s })),
        commandTile: scene.commandTile ? { ...scene.commandTile } : null,
        speed: scene.speedMultiplier,
        overlayMode: scene.overlayMode,
        logHistory: [...scene.logHistory],
        nextWorldEventTick: getNextEventTick(),
        weather: { ...scene.weather },
        worldSeed: scene.worldSeed,
        chapters: [...scene.chapters],
        goalStartTick: scene.goalStartTick,
        rooms: scene.rooms.map(r => ({ ...r })),
    };
}

export function emitGameState(scene: WorldScene) {
    const alive = scene.goblins.filter(d => d.alive);
    bus.emit('gameState', {
        tick: scene.tick,
        goblins: scene.goblins.map(d => ({ ...d })),
        totalFood: alive.reduce((s, d) => s + d.inventory.food, 0),
        totalMeals: alive.reduce((s, d) => s + d.inventory.meals, 0)
          + scene.mealStockpiles.reduce((s, sp) => s + sp.meals, 0),
        totalOre: alive.reduce((s, d) => s + d.inventory.ore, 0),
        totalWood: alive.reduce((s, d) => s + d.inventory.wood, 0),
        selectedGoblinId: scene.selectedGoblinId,
        overlayMode: scene.overlayMode,
        paused: scene.paused,
        speed: scene.speedMultiplier,
        colonyGoal: { ...scene.colonyGoal },
        foodStockpiles: scene.foodStockpiles.map(d => ({ ...d })),
        mealStockpiles: scene.mealStockpiles.map(d => ({ ...d })),
        oreStockpiles: scene.oreStockpiles.map(s => ({ ...s })),
        woodStockpiles: scene.woodStockpiles.map(s => ({ ...s })),
        plankStockpiles: scene.plankStockpiles.map(s => ({ ...s })),
        barStockpiles: scene.barStockpiles.map(s => ({ ...s })),
        weatherSeason: scene.weather.season,
        weatherType: scene.weather.type,
        rooms: scene.rooms.map(r => ({ ...r })),
    });
}

export function emitMiniMap(scene: WorldScene) {
    const cam = scene.cameras.main;
    const tpx = TILE_SIZE;
    const view = cam.worldView;
    const data: MiniMapData = {
        tiles: scene.grid.map(row => row.map(t => ({
            type: t.type,
            foodRatio: t.maxFood > 0 ? t.foodValue / t.maxFood : 0,
            matRatio: t.maxMaterial > 0 ? t.materialValue / t.maxMaterial : 0,
        }))),
        goblins: scene.goblins
            .filter(d => d.alive)
            .map(d => ({ x: d.x, y: d.y, hunger: d.hunger })),
        adventurers: scene.adventurers.map(g => ({ x: g.x, y: g.y })),
        viewport: {
            x: view.x / tpx,
            y: view.y / tpx,
            w: view.width / tpx,
            h: view.height / tpx,
        },
    };
    bus.emit('miniMapUpdate', data);
}
