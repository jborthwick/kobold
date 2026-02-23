import mitt from 'mitt';
import type { GameState, LogEntry } from './types';

type Events = {
  gameState: GameState;
  logEntry:  LogEntry;
};

export const bus = mitt<Events>();
