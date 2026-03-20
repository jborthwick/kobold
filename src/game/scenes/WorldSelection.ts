import { bus } from '../../shared/events';
import { emitGameState } from './WorldState';
import type { WorldScene } from './WorldScene';

export type StockpileKind = 'food' | 'ore' | 'wood' | 'meal' | 'plank' | 'bar';

export function clearSelections(scene: WorldScene, emitState: boolean) {
    scene.selectedGoblinId = null;
    scene.selectedHearth = null;
    scene.selectedStockpile = null;
    scene.selectedAdventurerId = null;
    bus.emit('stockpileSelect', null);
    bus.emit('hearthSelect', null);
    bus.emit('adventurerSelect', null);
    if (emitState) emitGameState(scene);
}

export function selectAdventurer(scene: WorldScene, adventurer: { id: string }) {
    scene.selectedGoblinId = null;
    scene.selectedHearth = null;
    scene.selectedStockpile = null;
    scene.selectedAdventurerId = adventurer.id;
    bus.emit('stockpileSelect', null);
    bus.emit('hearthSelect', null);
    bus.emit('adventurerSelect', adventurer);
}

export function selectGoblin(scene: WorldScene, goblinId: string) {
    scene.selectedGoblinId = goblinId;
    scene.selectedHearth = null;
    scene.selectedStockpile = null;
    scene.selectedAdventurerId = null;
    bus.emit('stockpileSelect', null);
    bus.emit('hearthSelect', null);
    bus.emit('adventurerSelect', null);
    emitGameState(scene);
}

export function selectStockpile(scene: WorldScene, selection: { kind: StockpileKind; idx: number }) {
    scene.selectedGoblinId = null;
    scene.selectedHearth = null;
    scene.selectedAdventurerId = null;
    scene.selectedStockpile = selection;
    bus.emit('adventurerSelect', null);
    bus.emit('stockpileSelect', selection);
    bus.emit('hearthSelect', null);
}

export function selectHearth(scene: WorldScene, x: number, y: number) {
    scene.selectedGoblinId = null;
    scene.selectedHearth = { x, y };
    scene.selectedStockpile = null;
    scene.selectedAdventurerId = null;
    bus.emit('adventurerSelect', null);
    bus.emit('stockpileSelect', null);
    bus.emit('hearthSelect', { x, y });
}
