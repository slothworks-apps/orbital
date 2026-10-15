import { describe, expect, it } from 'vitest';
import { presenceReport } from '../src/lib/presence';

describe('presenceReport', () => {
  it('beats while active, says leaving once, then stays silent', () => {
    expect(presenceReport('active', false)).toBe(true);
    expect(presenceReport('active', true)).toBe(true);
    for (const state of ['idle', 'locked', 'unknown'] as const) {
      expect(presenceReport(state, true)).toBe(false);
      expect(presenceReport(state, false)).toBeNull();
    }
  });
});
