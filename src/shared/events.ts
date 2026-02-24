import mitt from 'mitt';
import type { GameState, LogEntry, TileInfo } from './types';

type Events = {
  gameState:      GameState;
  logEntry:       LogEntry;
  settingsChange: { llmEnabled: boolean };
  tileHover:      TileInfo | null;
};

export const bus = mitt<Events>();
