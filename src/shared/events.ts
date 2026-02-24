import mitt from 'mitt';
import type { GameState, LogEntry } from './types';

type Events = {
  gameState:      GameState;
  logEntry:       LogEntry;
  settingsChange: { llmEnabled: boolean };
};

export const bus = mitt<Events>();
