import { describe, expect, it } from 'vitest';
import type { ColonyGoal, Goblin, LogEntry } from '../shared/types';
import {
  STORYTELLER_SYSTEM_PROMPT,
  buildStorytellerUserPrompt,
  humanizeEventSpeaker,
  sanitizeLogMessageForStoryteller,
  selectChapterEvents,
} from './storytellerPrompt';

describe('selectChapterEvents', () => {
  it('prioritizes World and Raid over filler Weather when capped', () => {
    const logs: LogEntry[] = [];
    for (let t = 1; t <= 25; t++) {
      logs.push({
        tick: t,
        goblinId: 'system',
        goblinName: 'WEATHER',
        message: `Weather note ${t}`,
        level: 'info',
      });
    }
    logs.push({
      tick: 10,
      goblinId: 'world',
      goblinName: 'WORLD',
      message: 'A blight withers the mushroom patch.',
      level: 'warn',
    });
    logs.push({
      tick: 12,
      goblinId: 'adventurer',
      goblinName: 'RAID',
      message: '⚔ 3 adventurers storm from the north !',
      level: 'error',
    });

    const lines = selectChapterEvents(logs, 0);
    const joined = lines.join('\n');
    expect(joined).toContain('World');
    expect(joined).toContain('Raid');
    expect(lines.filter(l => l.includes('Weather')).length).toBeLessThanOrEqual(2);
  });

  it('includes goblin death errors ahead of generic warns', () => {
    const logs: LogEntry[] = [
      {
        tick: 5,
        goblinId: 'g1',
        goblinName: 'Snib',
        message: 'killed by adventurers!',
        level: 'error',
      },
      ...Array.from({ length: 30 }, (_, i) => ({
        tick: 6 + i,
        goblinId: 'g2',
        goblinName: 'Blix',
        message: '😤 morale is dangerously low',
        level: 'warn' as const,
      })),
    ];
    const lines = selectChapterEvents(logs, 0);
    expect(lines.some(l => l.includes('Snib') && l.includes('killed'))).toBe(true);
  });

  it('sanitizes hp and uses humanized Colony label', () => {
    const logs: LogEntry[] = [
      {
        tick: 1,
        goblinId: 'g1',
        goblinName: 'Zot',
        message: '⚔ fighting human (3 hits taken, 12.5 hp)',
        level: 'warn',
      },
      {
        tick: 2,
        goblinId: 'world',
        goblinName: 'COLONY',
        message: '✓ Goal complete: test',
        level: 'info',
      },
    ];
    const lines = selectChapterEvents(logs, 0);
    expect(lines.some(l => l.includes('Colony:'))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/\d+\s*hp/i);
  });
});

describe('humanizeEventSpeaker', () => {
  it('labels GOBLIN log channel as adventurers (human raiders), not colonists', () => {
    expect(humanizeEventSpeaker('GOBLIN')).toBe('Adventurers');
    expect(humanizeEventSpeaker('Murg')).toBe('Murg');
    expect(humanizeEventSpeaker('COLONY')).toBe('Colony');
  });
});

describe('sanitizeLogMessageForStoryteller', () => {
  it('removes hp parentheticals and Lv tags', () => {
    expect(sanitizeLogMessageForStoryteller('(95 hp)')).not.toContain('95');
    expect(sanitizeLogMessageForStoryteller('⭐ forage Lv.2!')).not.toContain('Lv.');
    expect(sanitizeLogMessageForStoryteller('[FORAGE Lv.2] did a thing')).not.toContain('Lv.');
  });
});

describe('buildStorytellerUserPrompt', () => {
  it('omits skill levels from roster', () => {
    const goblin = {
      id: '1',
      name: 'Murg',
      alive: true,
      trait: 'greedy',
      bio: 'Short bio',
      goal: 'Mine',
      hunger: 10,
      morale: 50,
      fatigue: 0,
      social: 50,
      skills: { forage: 2 },
    } as unknown as Goblin;
    const goal: ColonyGoal = {
      type: 'build_rooms',
      description: 'Build a kitchen',
      progress: 1,
      target: 1,
      generation: 0,
    };
    const user = buildStorytellerUserPrompt({
      completedGoal: goal,
      goblins: [goblin],
      adventurers: [],
      eventLines: [],
      personaId: 'balanced',
    });
    expect(user).not.toMatch(/Lv\.|strongest skill/i);
    expect(user).toContain('Murg');
  });

  it('system prompt bans stats, robotic patterns, and clarifies colonists vs raiders', () => {
    expect(STORYTELLER_SYSTEM_PROMPT).toMatch(/hitpoints|Lv\./i);
    expect(STORYTELLER_SYSTEM_PROMPT).toMatch(/Meanwhile|camera-pan|invented scenery/i);
    expect(STORYTELLER_SYSTEM_PROMPT).toMatch(/colonists are goblins|Never call colonists outsiders/i);
    expect(STORYTELLER_SYSTEM_PROMPT).toContain('colonist goblins total');
  });
});
