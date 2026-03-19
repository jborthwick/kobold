import { bus } from '../../shared/events';
import { getGoblinConfig } from '../../shared/goblinConfig';
import { filterSignificantEvents, callStorytellerLLM, buildFallbackChapter } from '../../ai/storyteller';
import type { ColonyGoal, Chapter, Goblin } from '../../shared/types';
import type { WorldScene } from './WorldScene';
import { GOAL_CONFIG, GOAL_ORDER } from '../../simulation/goalConfig';

export function makeGoal(type: ColonyGoal['type'], generation: number): ColonyGoal {
    const cfg = GOAL_CONFIG[type];
    const target = Math.round(cfg.baseTarget * (1 + generation * cfg.scaleFactor));
    const desc = getGoblinConfig().goalDescriptions;
    switch (type) {
        case 'build_rooms':
            return { type, description: desc.build_rooms(), progress: 0, target, generation };
        case 'cook_meals':
            return { type, description: desc.cook_meals(target), progress: 0, target, generation };
        case 'survive_ticks':
            return { type, description: desc.survive_ticks(target), progress: 0, target, generation };
        case 'defeat_adventurers':
            return { type, description: desc.defeat_adventurers(target), progress: 0, target, generation };
    }
}

export function updateGoalProgress(scene: WorldScene) {
    const alive = scene.goblins.filter(d => d.alive);
    switch (scene.colonyGoal.type) {
        case 'build_rooms': {
            const storageCount = scene.rooms.filter(r => r.type === 'storage').length;
            const kitchenCount = scene.rooms.filter(r => r.type === 'kitchen').length;
            scene.colonyGoal.progress = Math.min(1, storageCount) + (kitchenCount >= 1 ? 1 : 0);
            break;
        }
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
    const curr = GOAL_ORDER.indexOf(scene.colonyGoal.type);
    const next = GOAL_ORDER[(curr + 1) % GOAL_ORDER.length];

    // Reset relevant counters so the new goal tracks from zero
    // Note: food stockpile and ore stockpile totals are intentionally NOT cleared on goal completion
    if (next === 'defeat_adventurers') scene.adventurerKillCount = 0;

    scene.goalStartTick = scene.tick;
    scene.colonyGoal = makeGoal(next, gen);

    // Fire storyteller (detached — never blocks game loop)
    const significantEvents = filterSignificantEvents(scene.logHistory, scene.lastChapterTick);
    const chapterNum = scene.chapters.length + 1;
    const snapshotTick = scene.tick;
    callStorytellerLLM(
      completedGoal,
      scene.goblins,
      scene.adventurers,
      significantEvents,
      undefined,
      [...scene.chapters],
    )
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
            bus.emit('chronicleModal', { open: true, chapter, allChapters: scene.chapters });
        });
}
