import { describe, it, expect } from 'vitest';
import {
  SESSION_TIPS,
  NARRATE_COMMENTARY_PROMPT,
  composeAppendix,
} from '../src/runner/sessionInstructions.js';

// Spec 2026-09-30-session-instructions-design § 1, § 2, § 5.
const allOff = { tipsOn: false, commentary: false, customOn: false, customText: '' };
const tipsText = SESSION_TIPS.map((t) => t.text).join('\n\n');

describe('SESSION_TIPS', () => {
  it('has unique ids', () => {
    const ids = SESSION_TIPS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ships the three tips the spec names, in its order', () => {
    expect(SESSION_TIPS.map((t) => t.id)).toEqual([
      'ask-user-question',
      'paths-in-code-spans',
      'long-commands-in-background',
    ]);
  });
});

describe('composeAppendix', () => {
  it('returns null when nothing survives', () => {
    expect(composeAppendix(allOff)).toBeNull();
    expect(composeAppendix({ ...allOff, customOn: true, customText: '' })).toBeNull();
    expect(composeAppendix({ ...allOff, customOn: true, customText: '  \n\r\n\t ' })).toBeNull();
  });

  it('emits the tips alone, in array order', () => {
    expect(composeAppendix({ ...allOff, tipsOn: true })).toBe(tipsText);
  });

  it('emits the commentary alone', () => {
    expect(composeAppendix({ ...allOff, commentary: true })).toBe(NARRATE_COMMENTARY_PROMPT);
  });

  it('emits the custom text alone, trimmed', () => {
    expect(composeAppendix({ ...allOff, customOn: true, customText: '\n Answer in Czech. \n' }))
      .toBe('Answer in Czech.');
  });

  it('drops the custom text while its switch is off even if it has content', () => {
    expect(composeAppendix({ ...allOff, customOn: false, customText: 'Answer in Czech.' })).toBeNull();
  });

  it('orders tips, commentary, custom text with a blank line between blocks', () => {
    const out = composeAppendix({
      tipsOn: true, commentary: true, customOn: true, customText: 'Answer in Czech.',
    });
    expect(out).toBe(`${tipsText}\n\n${NARRATE_COMMENTARY_PROMPT}\n\nAnswer in Czech.`);
  });

  it('honours tipsOff for a known id and ignores an unknown one', () => {
    const [first, ...rest] = SESSION_TIPS;
    expect(composeAppendix({ ...allOff, tipsOn: true, tipsOff: [first.id, 'no-such-tip'] }))
      .toBe(rest.map((t) => t.text).join('\n\n'));
    expect(composeAppendix({ ...allOff, tipsOn: true, tipsOff: ['no-such-tip'] })).toBe(tipsText);
  });

  it('returns null when every tip is off and nothing else is on', () => {
    expect(composeAppendix({ ...allOff, tipsOn: true, tipsOff: SESSION_TIPS.map((t) => t.id) }))
      .toBeNull();
  });
});
