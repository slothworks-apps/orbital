import { describe, it, expect } from 'vitest';
import { parseWalkthroughTag, walkthroughChipName, WALKTHROUGH_TAG } from '../src/walkthrough/tag.js';

describe('parseWalkthroughTag', () => {
  it('returns null for text without the tag', () => {
    expect(parseWalkthroughTag('plain question')).toBeNull();
    expect(parseWalkthroughTag('<command-name>/x</command-name>')).toBeNull();
  });

  it('reads a narrate tag', () => {
    expect(parseWalkthroughTag(`<${WALKTHROUGH_TAG} kind="narrate">\nsteps\n</${WALKTHROUGH_TAG}>`))
      .toEqual({ kind: 'narrate' });
  });

  it('reads an ask tag with step and ordinal', () => {
    const text = `Why?\n<${WALKTHROUGH_TAG} kind="ask" step="toolu_1" n="3">ctx</${WALKTHROUGH_TAG}>`;
    expect(parseWalkthroughTag(text)).toEqual({ kind: 'ask', step: 'toolu_1', n: 3 });
  });

  it('tolerates a missing or malformed n', () => {
    expect(parseWalkthroughTag(`<${WALKTHROUGH_TAG} kind="ask" step="toolu_1">x</${WALKTHROUGH_TAG}>`))
      .toEqual({ kind: 'ask', step: 'toolu_1', n: null });
    expect(parseWalkthroughTag(`<${WALKTHROUGH_TAG} kind="ask" step="toolu_1" n="x">x</${WALKTHROUGH_TAG}>`))
      .toEqual({ kind: 'ask', step: 'toolu_1', n: null });
  });

  it('rejects an ask without a step and an unknown kind', () => {
    expect(parseWalkthroughTag(`<${WALKTHROUGH_TAG} kind="ask">x</${WALKTHROUGH_TAG}>`)).toBeNull();
    expect(parseWalkthroughTag(`<${WALKTHROUGH_TAG} kind="other">x</${WALKTHROUGH_TAG}>`)).toBeNull();
  });
});

describe('walkthroughChipName', () => {
  it('names each kind', () => {
    expect(walkthroughChipName({ kind: 'narrate' })).toBe('walkthrough · narrate');
    expect(walkthroughChipName({ kind: 'ask', step: 's', n: 3 })).toBe('walkthrough · ask · step 3');
    expect(walkthroughChipName({ kind: 'ask', step: 's', n: null })).toBe('walkthrough · ask');
  });
});
