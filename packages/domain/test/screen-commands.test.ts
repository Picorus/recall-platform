// P2.12: remote commands, and the shared cases the Kotlin player passes (test-vectors/screen-commands.json).
// Regenerate after a deliberate change with: UPDATE_VECTORS=1 pnpm --filter @recall/domain test
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  commandText,
  parseCommand,
  type CommandName,
  type ScreenCommand,
} from '../src/screen-commands.js';
import { newScreenId } from '../src/screen-identity.js';
import { checkReport } from '../src/screen-reports.js';

const FILE = new URL('../test-vectors/screen-commands.json', import.meta.url);
const MADE = 1_793_620_000_000;
const SCREEN = newScreenId([1, 2, 3, 4, 5, 6, 7]);
const cmd = (d: CommandName, value: number | null, id = `c-${d}-0001`): ScreenCommand => ({
  id,
  screen: SCREEN,
  made: MADE,
  until: MADE + 600_000,
  do: d,
  value,
});
const taken = [
  cmd('reboot', null),
  cmd('blank', null),
  cmd('unblank', null),
  cmd('test-pattern', 60),
  cmd('brightness', 40),
  cmd('brightness', null, 'c-brightness-auto'),
  cmd('send-logs', null),
  cmd('clear-cache', null),
].map((c) => ({ text: commandText(c), command: c }));

const good = JSON.parse(commandText(cmd('reboot', null))) as Record<string, unknown>;
const text = (o: Record<string, unknown>) => JSON.stringify({ ...good, ...o });
const refused = [
  { text: 'nope', problem: 'not a command' },
  { text: text({ extra: 1 }), problem: 'not a command' },
  { text: text({ v: 2 }), problem: 'unknown version' },
  { text: text({ id: 'short' }), problem: 'bad id' },
  { text: text({ id: 'has space in it' }), problem: 'bad id' },
  { text: text({ screen: 'SCR-1' }), problem: 'bad screen' },
  { text: text({ made: 0 }), problem: 'bad time' },
  { text: text({ until: MADE }), problem: 'bad until' },
  { text: text({ until: MADE + 3_600_001 }), problem: 'bad until' },
  { text: text({ do: 'format-disk' }), problem: 'unknown command' },
  { text: text({ value: 5 }), problem: 'bad value' },
  { text: text({ do: 'brightness', value: 0 }), problem: 'bad value' },
  { text: text({ do: 'brightness', value: 101 }), problem: 'bad value' },
  { text: text({ do: 'test-pattern', value: null }), problem: 'bad value' },
  { text: text({ do: 'test-pattern', value: 601 }), problem: 'bad value' },
  { text: text({ do: 'test-pattern', value: 4 }), problem: 'bad value' },
];

describe('remote commands (P2.12)', () => {
  const vectors = `${JSON.stringify({ screen: SCREEN, taken, refused }, null, 2)}\n`;
  if (process.env.UPDATE_VECTORS === '1' || !existsSync(FILE)) writeFileSync(FILE, vectors);

  it('shared cases are up to date', () => {
    expect(readFileSync(FILE, 'utf8')).toBe(vectors);
  });

  it('reads back what it writes, and refuses the rest with the same reason as the box', () => {
    for (const t of taken) expect(parseCommand(t.text)).toEqual(t.command);
    for (const r of refused) expect(parseCommand(r.text)).toEqual({ problem: r.problem });
    expect(() => commandText(cmd('brightness', 0))).toThrow('bad value');
  });

  it("the box's answers pass the report check; anything else is refused", () => {
    const answer = {
      kind: 'command',
      id: 'c-reboot-0001',
      at: 1_793_620_010,
      result: 'done',
      note: '',
    };
    expect(checkReport(answer)).toBeUndefined();
    expect(checkReport({ ...answer, result: 'refused', note: 'expired' })).toBeUndefined();
    expect(checkReport({ ...answer, note: 'log line 1\nlog line 2' })).toBeUndefined();
    expect(checkReport({ ...answer, result: 'maybe' })).toBe('bad result');
    expect(checkReport({ ...answer, note: 'x'.repeat(4_001) })).toBe('bad note');
    expect(checkReport({ ...answer, note: 'café' })).toBe('bad note');
    expect(checkReport({ ...answer, id: 'bad id!' })).toBe('bad command id');
    expect(checkReport({ ...answer, picture: 'x' })).toBe('unknown field: picture');
  });
});
