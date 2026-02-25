import mitt from 'mitt';
import type { GameState, LogEntry, TileInfo, MiniMapData, Goblin } from './types';

type Events = {
  gameState:      GameState;
  logEntry:       LogEntry;
  clearLog:       undefined;
  restoreLog:     LogEntry[];
  settingsChange: { llmEnabled: boolean };
  tileHover:      TileInfo | null;
  miniMapUpdate:  MiniMapData;
  controlChange:  { action: 'pause' | 'speedUp' | 'speedDown' | 'newColony' };
  stockpileSelect: { kind: 'food' | 'ore'; idx: number } | null;
  goblinSelect:    Goblin | null;
  tokenUsage:      { inputTotal: number; outputTotal: number; callCount: number; lastInput: number; lastOutput: number };
};

export const bus = mitt<Events>();
