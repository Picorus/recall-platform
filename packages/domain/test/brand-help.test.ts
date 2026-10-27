// P5.9: Help's answers and the ad rules in words.
import { describe, expect, it } from 'vitest';
import { adRulesText, brandHelp, DEFAULT_AD_RULES } from '../src/index.js';

describe('brand portal help (P5.9)', () => {
  it('the ad rules say what the checks check', () => {
    const t = adRulesText(DEFAULT_AD_RULES).join(' ');
    expect(t).toContain('exactly 15 seconds');
    expect(t).toContain('2 : 1');
    expect(t).toContain('30 MB');
    expect(adRulesText({ ...DEFAULT_AD_RULES, spotMs: 10_000 })[0]).toContain('10 seconds');
  });
  it('answers are short, unique, and never promise a number that is a setting', () => {
    const help = brandHelp(200);
    expect(help[0]?.a).toContain('200 times');
    expect(brandHelp(180)[0]?.a).toContain('180 times');
    expect(new Set(help.map((x) => x.q)).size).toBe(help.length);
    for (const x of help) {
      expect(x.a.length).toBeLessThan(300);
      // Lead days, deadlines and prices live in the price book: not written into answers.
      expect(x.a).not.toMatch(/\d+ days|₹/);
    }
  });
});
