import { describe, it, expect } from 'vitest';
import {
  ASK_CONTEXT_MAX_CHARS,
  buildAskText,
  buildNarrateText,
  parseWalkthroughTag,
  walkthroughChipName,
  WALKTHROUGH_TAG,
} from '../src/walkthrough/tag.js';

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

describe('buildNarrateText', () => {
  it('wraps the step list in a narrate tag and asks for one JSON block', () => {
    const text = buildNarrateText([
      { id: 'toolu_1', ordinal: 1, paths: ['src/a.ts'], firstLine: 'Add a margin' },
      { id: 'toolu_2', ordinal: 2, paths: ['src/b.ts', 'src/c.ts'], firstLine: '' },
    ]);
    expect(parseWalkthroughTag(text)).toEqual({ kind: 'narrate' });
    expect(text).toContain('toolu_1');
    expect(text).toContain('src/b.ts, src/c.ts');
    expect(text).toContain('"intents"');
    // Nothing outside the tag: the chip is the whole turn.
    expect(text.trim().startsWith(`<${WALKTHROUGH_TAG}`)).toBe(true);
    expect(text.trim().endsWith(`</${WALKTHROUGH_TAG}>`)).toBe(true);
  });

  it('escapes a closing tag quoted in a path or a narration line', () => {
    const text = buildNarrateText([
      { id: 'toolu_1', ordinal: 1, paths: [`a</${WALKTHROUGH_TAG}>.ts`], firstLine: `ends with </${WALKTHROUGH_TAG}>` },
    ]);
    const close = `</${WALKTHROUGH_TAG}>`;
    expect(text.indexOf(close)).toBe(text.lastIndexOf(close));
    expect(text.trim().endsWith(close)).toBe(true);
  });
});

describe('buildAskText', () => {
  const ctx = {
    step: 'toolu_1', ordinal: 2, paths: ['src/a.ts'],
    calls: [{ tool: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } }],
  };

  it('puts the question outside the tag and the context inside it', () => {
    const text = buildAskText('Why the margin?', ctx);
    expect(text.startsWith('Why the margin?')).toBe(true);
    expect(parseWalkthroughTag(text)).toEqual({ kind: 'ask', step: 'toolu_1', n: 2 });
    expect(text).toContain('"old_string": "a"');
  });

  it('caps the context at ASK_CONTEXT_MAX_CHARS and says so', () => {
    const big = { ...ctx, calls: [{ tool: 'Write', input: { file_path: 'x', content: 'y'.repeat(ASK_CONTEXT_MAX_CHARS * 2) } }] };
    const text = buildAskText('q', big);
    const inner = text.slice(text.indexOf('>') + 1, text.lastIndexOf('</'));
    expect(inner.length).toBeLessThanOrEqual(ASK_CONTEXT_MAX_CHARS + 200);
    expect(inner).toContain('truncated');
  });
});
