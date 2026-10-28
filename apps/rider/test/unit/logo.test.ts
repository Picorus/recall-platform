import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOCKUP_DARK } from '../../src/logo';

describe('logo', () => {
  it('is the brand file, unchanged', () => {
    const file = readFileSync(
      new URL(
        '../../../../packages/design/brand/logo/recall-lockup-horizontal-dark.svg',
        import.meta.url,
      ),
      'utf8',
    );
    expect(LOCKUP_DARK).toBe(file.trim());
  });
});
