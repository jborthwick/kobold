import { bus } from '../../shared/events';
import { getActiveFaction } from '../../shared/factions';
import { filterSignificantEvents, callStorytellerLLM, buildFallbackChapter } from '../../ai/storyteller';
import type { ColonyGoal, Chapter, Goblin } from '../../shared/types';
import type { WorldScene } from './WorldScene';

export function makeGoal(type: ColonyGoal['type'], generation: number): ColonyGoal {
    const scale = 1 + generation * 0.6;
    const desc = getActiveFaction().goalDescriptions;
    switch (type) {
        case 'cook_meals':
            return { type, description: desc.cook_meals(Math.round(20 * scale)), progress: 0, target: Math.round(20 * scale), generation };
        case 'survive_ticks':
            return { type, description: desc.survive_ticks(Math.round(400 * scale)), progress: 0, target: Math.round(400 * scale), generation };
        case 'defeat_adventurers':
            return { type, description: desc.defeat_adventurers(Math.round(5 * scale)), progress: 0, target: Math.round(5 * scale), generation };
    }
    return { type: 'cook_meals', description: '', progress: 0, target: 20, generation };
}

export function updateGoalProgress(scene: WorldScene) {
    const alive = scene.goblins.filter(d => d.alive);
    switch (scene.colonyGoal.type) {
        case 'cook_meals':
            scene.colonyGoal.progress = scene.mealsCooked;
            break;
        case 'survive_ticks':
            scene.colonyGoal.progress = scene.tick - scene.goalStartTick;
            break;
        case 'defeat_adventurers':
            scene.colonyGoal.progress = scene.adventurerKillCount;
            break;
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
    const GOAL_TYPES: ColonyGoal['type'][] = ['cook_meals', 'survive_ticks', 'defeat_adventurers'];
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
