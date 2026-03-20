import { bus } from '../../shared/events';
import type { SceneSelection } from '../../shared/types';
import { emitGameState } from './WorldState';
import type { WorldScene } from './WorldScene';

export type StockpileKind = 'food' | 'ore' | 'wood' | 'meal' | 'plank' | 'bar';

function applySelection(scene: WorldScene, selection: SceneSelection, emitState: boolean) {
    scene.selection = selection;

    bus.emit(
        'stockpileSelect',
        selection.kind === 'stockpile' ? { kind: selection.stockpileKind, idx: selection.idx } : null
    );
    bus.emit(
        'hearthSelect',
        selection.kind === 'hearth' ? { x: selection.x, y: selection.y } : null
    );
    if (selection.kind === 'adventurer') {
        const adventurer = scene.adventurers.find(a => a.id === selection.adventurerId) ?? null;
        bus.emit('adventurerSelect', adventurer);
    } else {
        bus.emit('adventurerSelect', null);
    }

    if (emitState) emitGameState(scene);
}

export function getSelectedGoblinId(scene: WorldScene): string | null {
    return scene.selection.kind === 'goblin' ? scene.selection.goblinId : null;
}

export function clearSelections(scene: WorldScene, emitState: boolean) {
    applySelection(scene, { kind: 'none' }, emitState);
}

export function selectAdventurer(scene: WorldScene, adventurer: { id: string }) {
    applySelection(scene, { kind: 'adventurer', adventurerId: adventurer.id }, false);
}

export function selectGoblin(scene: WorldScene, goblinId: string) {
    applySelection(scene, { kind: 'goblin', goblinId }, true);
}

export function selectStockpile(scene: WorldScene, selection: { kind: StockpileKind; idx: number }) {
    applySelection(scene, { kind: 'stockpile', stockpileKind: selection.kind, idx: selection.idx }, false);
}

export function selectHearth(scene: WorldScene, x: number, y: number) {
    applySelection(scene, { kind: 'hearth', x, y }, false);
}
