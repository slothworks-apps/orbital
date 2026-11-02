import { describe, expect, it } from 'vitest';
import { hookNoticeLead, hookNoticeText, hookWaitCaption, type LiveHookNotice } from '../src/hookNotice.js';

const stop: LiveHookNotice = { event: 'Stop', count: 1, cancellable: true, messagesWaiting: 0 };

describe('the hook row', () => {
  it('names the event and how many hooks run', () => {
    expect(hookNoticeLead(stop)).toBe('Stop hook running');
    expect(hookNoticeLead({ ...stop, count: 2 })).toBe('Stop hooks running');
  });

  it('says a message waits, for one hook or several', () => {
    expect(hookNoticeLead({ ...stop, messagesWaiting: 1 })).toBe('Stop hook running — your message waits for it');
    expect(hookNoticeLead({ ...stop, messagesWaiting: 3 })).toBe('Stop hook running — your messages wait for it');
    expect(hookNoticeLead({ ...stop, count: 2, messagesWaiting: 1 })).toBe('Stop hooks running — your message waits for them');
  });

  it('puts the tool before the command, and leaves out what it does not know', () => {
    const pre: LiveHookNotice = { event: 'PreToolUse', tool: 'Bash', commands: ['./scripts/guard.sh'], count: 1, cancellable: false, messagesWaiting: 0 };
    expect(hookNoticeText(pre)).toBe('PreToolUse hook running · Bash · ./scripts/guard.sh');
    expect(hookNoticeText({ ...pre, commands: undefined })).toBe('PreToolUse hook running · Bash');
    expect(hookNoticeText({ event: 'SessionStart', commands: ['direnv export json'], count: 1, cancellable: false, messagesWaiting: 0 }))
      .toBe('SessionStart hook running · direnv export json');
    expect(hookNoticeText({ event: 'Stop', commands: ['pnpm test', 'tsc --noEmit'], count: 2, cancellable: true, messagesWaiting: 0 }))
      .toBe('Stop hooks running · pnpm test · tsc --noEmit');
  });

  it('captions the waiting messages once, counting them', () => {
    expect(hookWaitCaption(stop, 1)).toBe('waits for the Stop hook');
    expect(hookWaitCaption({ event: 'Stop', count: 2 }, 1)).toBe('waits for the Stop hooks');
    expect(hookWaitCaption(stop, 3)).toBe('3 messages wait for the Stop hook');
  });
});
