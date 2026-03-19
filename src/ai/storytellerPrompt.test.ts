import { describe, expect, it } from 'vitest';
import type { Chapter, ColonyGoal, Goblin, LogEntry } from '../shared/types';
import {
  STORYTELLER_SYSTEM_PROMPT,
  buildStorytellerUserPrompt,
  formatPriorChaptersBlock,
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

  it('system prompt bans stats, continuity rule, and clarifies colonists', () => {
    expect(STORYTELLER_SYSTEM_PROMPT).toMatch(/hitpoints|Lv\./i);
    expect(STORYTELLER_SYSTEM_PROMPT).toMatch(/camera-pan|Chronicle so far/i);
    expect(STORYTELLER_SYSTEM_PROMPT).toMatch(/colonists are goblins/i);
    expect(STORYTELLER_SYSTEM_PROMPT).toContain('colonist goblins total');
  });

  it('embeds prior chapter excerpts for chapter 2+', () => {
    const prior: Chapter[] = [
      {
        chapterNumber: 1,
        goalType: 'build_rooms',
        goalGeneration: 0,
        text: 'First chapter about mud and hope.',
        tick: 100,
      },
    ];
    const goal: ColonyGoal = {
      type: 'cook_meals',
      description: 'Cook meals',
      progress: 1,
      target: 1,
      generation: 1,
    };
    const user = buildStorytellerUserPrompt({
      completedGoal: goal,
      goblins: [],
      adventurers: [],
      eventLines: [],
      personaId: 'balanced',
      priorChapters: prior,
    });
    expect(user).toContain('Chronicle so far');
    expect(user).toContain('Chapter 1:');
    expect(user).toContain('mud and hope');
    expect(user).toContain('Chapter 2');
  });
});

describe('formatPriorChaptersBlock', () => {
  const ch = (n: number, text: string): Chapter => ({
    chapterNumber: n,
    goalType: 'survive_ticks',
    goalGeneration: n - 1,
    text,
    tick: n * 10,
  });

  it('truncates long chapter text', () => {
    const long = 'x'.repeat(400);
    const block = formatPriorChaptersBlock([ch(1, long)]);
    expect(block.length).toBeLessThan(long.length + 100);
    expect(block).toContain('…');
    expect(block).not.toContain('x'.repeat(350));
  });

  it('keeps only the last five chapters', () => {
    const chapters = Array.from({ length: 7 }, (_, i) => ch(i + 1, `Part ${i + 1}`));
    const block = formatPriorChaptersBlock(chapters);
    expect(block).toContain('Part 3');
    expect(block).toContain('Part 7');
    expect(block).not.toContain('Part 1');
    expect(block).not.toContain('Part 2');
  });
});
