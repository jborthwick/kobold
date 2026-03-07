import { bus } from '../../shared/events';
import { getActiveFaction } from '../../shared/factions';
import { filterSignificantEvents, callStorytellerLLM, buildFallbackChapter } from '../../ai/storyteller';
import { roomWallSlots } from '../../simulation/agents';
import type { ColonyGoal, Chapter, Goblin } from '../../shared/types';
import type { WorldScene } from './WorldScene';

export function makeGoal(type: ColonyGoal['type'], generation: number): ColonyGoal {
    const scale = 1 + generation * 0.6;
    const desc = getActiveFaction().goalDescriptions;
    switch (type) {
        case 'stockpile_food':
            return { type, description: desc.stockpile_food(Math.round(80 * scale)), progress: 0, target: Math.round(80 * scale), generation };
        case 'survive_ticks':
            return { type, description: desc.survive_ticks(Math.round(800 * scale)), progress: 0, target: Math.round(800 * scale), generation };
        case 'defeat_adventurers':
            return { type, description: desc.defeat_adventurers(Math.round(5 * scale)), progress: 0, target: Math.round(5 * scale), generation };
        case 'enclose_fort':
            return { type, description: desc.enclose_fort(), progress: 0, target: 1, generation };
    }
}

export function updateGoalProgress(scene: WorldScene) {
    const alive = scene.goblins.filter(d => d.alive);
    switch (scene.colonyGoal.type) {
        case 'stockpile_food':
            scene.colonyGoal.progress = scene.foodStockpiles.reduce((sum, d) => sum + d.food, 0);
            break;
        case 'survive_ticks':
            scene.colonyGoal.progress = scene.tick - scene.goalStartTick;
            break;
        case 'defeat_adventurers':
            scene.colonyGoal.progress = scene.adventurerKillCount;
            break;
        case 'enclose_fort': {
            const remaining = roomWallSlots(scene.rooms, scene.grid, scene.goblins, '', scene.adventurers);
            scene.colonyGoal.progress = (scene.rooms.length > 0 && remaining.length === 0) ? 1 : 0;
            break;
        }
    }
    if (scene.colonyGoal.progress >= scene.colonyGoal.target) {
        completeGoal(scene, alive);
    }
}

export function completeGoal(scene: WorldScene, alive: Goblin[]) {
    // Snapshot completed goal before cycling — needed for storyteller prompt
    const completedGoal = { ...scene.colonyGoal };
    const gen = scene.colonyGoal.generation + 1;
    for (const d of alive) {
        d.morale = Math.min(100, d.morale + 15);
    }
    bus.emit('logEntry', {
        tick: scene.tick,
        goblinId: 'world',
        goblinName: 'COLONY',
        message: `✓ Goal complete: ${scene.colonyGoal.description}! Morale boost for all!`,
        level: 'info',
    });
    const GOAL_TYPES: ColonyGoal['type'][] = ['stockpile_food', 'survive_ticks', 'defeat_adventurers', 'enclose_fort'];
    const curr = GOAL_TYPES.indexOf(scene.colonyGoal.type);
    const next = GOAL_TYPES[(curr + 1) % GOAL_TYPES.length];

    // Reset relevant counters so the new goal tracks from zero
    // Note: food stockpile and ore stockpile totals are intentionally NOT cleared on goal completion
    if (next === 'defeat_adventurers') scene.adventurerKillCount = 0;

    scene.goalStartTick = scene.tick;
    scene.colonyGoal = makeGoal(next, gen);

    // Fire storyteller (detached — never blocks game loop)
    const significantEvents = filterSignificantEvents(scene.logHistory, scene.lastChapterTick);
    const chapterNum = scene.chapters.length + 1;
    const snapshotTick = scene.tick;
    callStorytellerLLM(completedGoal, scene.goblins, scene.adventurers, significantEvents)
        .then(text => {
            const chapter: Chapter = {
                chapterNumber: chapterNum,
                goalType: completedGoal.type,
                goalGeneration: completedGoal.generation,
                text: text ?? buildFallbackChapter(completedGoal, alive, significantEvents),
                tick: snapshotTick,
            };
            scene.chapters.push(chapter);
            scene.lastChapterTick = snapshotTick;
            bus.emit('chronicleChapter', chapter);
        });
}
