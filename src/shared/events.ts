import mitt from 'mitt';
import type { GameState, LogEntry, TileInfo, MiniMapData } from './types';

type Events = {
  gameState:      GameState;
  logEntry:       LogEntry;
  settingsChange: { llmEnabled: boolean };
  tileHover:      TileInfo | null;
  miniMapUpdate:  MiniMapData;
};

export const bus = mitt<Events>();
