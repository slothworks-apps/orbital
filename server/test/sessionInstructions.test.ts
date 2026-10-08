import { describe, it, expect } from 'vitest';
import {
  SESSION_RULES,
  SESSION_TIPS,
  NARRATE_COMMENTARY_PROMPT,
  composeAppendix,
} from '../src/runner/sessionInstructions.js';

// Spec 2026-09-30-session-instructions-design § 1, § 2, § 5; the rules,
// spec 2026-10-08-kept-shells-design § 3.
const allOff = { tipsOn: false, commentary: false, customOn: false, customText: '' };
const tipsText = SESSION_TIPS.map((t) => t.text).join('\n\n');
const rules = SESSION_RULES.join('\n\n');
/** What follows the rules, which every appendix opens with. */
const afterRules = (text: string) => `${rules}\n\n${text}`;

describe('SESSION_TIPS', () => {
  it('has unique ids', () => {
    const ids = SESSION_TIPS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ships the tips the spec names, in its order', () => {
    expect(SESSION_TIPS.map((t) => t.id)).toEqual([
      'ask-user-question',
      'paths-in-code-spans',
      'long-commands-in-background',
      'stop-background-tasks-when-done',
    ]);
  });
});

describe('composeAppendix', () => {
  it('keeps the rules when every switch is off', () => {
    expect(composeAppendix(allOff)).toBe(rules);
    expect(composeAppendix({ ...allOff, customOn: true, customText: '' })).toBe(rules);
    expect(composeAppendix({ ...allOff, customOn: true, customText: '  \n\r\n\t ' })).toBe(rules);
    expect(composeAppendix({ ...allOff, tipsOn: true, tipsOff: SESSION_TIPS.map((t) => t.id) })).toBe(rules);
  });

  it('emits the tips after the rules, in array order', () => {
    expect(composeAppendix({ ...allOff, tipsOn: true })).toBe(afterRules(tipsText));
  });

  it('emits the commentary after the rules', () => {
    expect(composeAppendix({ ...allOff, commentary: true })).toBe(afterRules(NARRATE_COMMENTARY_PROMPT));
  });

  it('emits the custom text after the rules, trimmed', () => {
    expect(composeAppendix({ ...allOff, customOn: true, customText: '\n Answer in Czech. \n' }))
      .toBe(afterRules('Answer in Czech.'));
  });

  it('drops the custom text while its switch is off even if it has content', () => {
    expect(composeAppendix({ ...allOff, customOn: false, customText: 'Answer in Czech.' })).toBe(rules);
  });

  it('orders rules, tips, commentary, custom text with a blank line between blocks', () => {
    const out = composeAppendix({
      tipsOn: true, commentary: true, customOn: true, customText: 'Answer in Czech.',
    });
    expect(out).toBe(afterRules(`${tipsText}\n\n${NARRATE_COMMENTARY_PROMPT}\n\nAnswer in Czech.`));
  });

  it('honours tipsOff for a known id and ignores an unknown one', () => {
    const [first, ...rest] = SESSION_TIPS;
    expect(composeAppendix({ ...allOff, tipsOn: true, tipsOff: [first.id, 'no-such-tip'] }))
      .toBe(afterRules(rest.map((t) => t.text).join('\n\n')));
    expect(composeAppendix({ ...allOff, tipsOn: true, tipsOff: ['no-such-tip'] })).toBe(afterRules(tipsText));
  });
});
