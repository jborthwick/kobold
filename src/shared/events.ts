import mitt from 'mitt';
import type { GameState, LogEntry, TileInfo, MiniMapData, Goblin, OverlayMode } from './types';

type Events = {
  gameState:      GameState;
  logEntry:       LogEntry;
  clearLog:       undefined;
  restoreLog:     LogEntry[];
  settingsChange: { llmEnabled: boolean };
  tileHover:      TileInfo | null;
  miniMapUpdate:  MiniMapData;
  controlChange:  { action: 'pause' | 'speedUp' | 'speedDown' | 'newColony' };
  stockpileSelect: { kind: 'food' | 'ore' | 'wood'; idx: number } | null;
  goblinSelect:    Goblin | null;
  tokenUsage:      { inputTotal: number; outputTotal: number; callCount: number; lastInput: number; lastOutput: number };
  /** Mobile on-screen button: cycle overlay mode */
  overlayChange:  { mode: OverlayMode };
  /** Mobile on-screen button: cycle selected dwarf */
  cycleSelected:  { direction: 1 | -1 };
};

export const bus = mitt<Events>();
