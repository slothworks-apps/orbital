import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db/database.js';
import { rewinds, sessions } from '../src/db/schema.js';
import { contextReportAt, keepContextReport, keptContextReport, latestContextTwin } from '../src/contextReport/store.js';
import { indexPaths } from '../src/indexer/indexer.js';
import { retentionCutoff, sweepSessions } from '../src/retention.js';
import { makeTmpDir, openTmpDb } from './tmp.js';

/**
 * The latest `/context` report Orbital keeps per session (spec
 * 2026-11-19-context-report-dialog-design § Opening it from the context
 * read-out): the newer of a typed `/context` and one taken from the read-out.
 */
const READOUT = { kind: 'readout' } as const;

const report = (totalTokens: number) => ({
  model: 'claude-opus-5', totalTokens, rawMaxTokens: 200000, percentage: 1,
  categories: [], mcpTools: [], memoryFiles: [], agents: [], skills: [],
});

/** A `/context` answer as the CLI writes it to the transcript, twin included. */
const contextEntry = (timestamp: string, totalTokens: number, stream = 'stdout') => ({
  type: 'system', subtype: 'local_command', uuid: `u-${timestamp}`, timestamp,
  content: `<local-command-${stream}>## Context Usage</local-command-${stream}>`,
  contextUsage: {
    model: 'claude-opus-5', total_tokens: totalTokens, raw_max_tokens: 200000, percentage: 1, categories: [],
  },
});

describe('the kept report', () => {
  it('keeps the newer one and never goes back to an older one', () => {
    const db = openTmpDb('ctxr');
    expect(contextReportAt(db, 's1')).toBeNull();
    expect(keepContextReport(db, 's1', { report: report(1) as any, takenAt: 2000, origin: READOUT })).toBe(true);
    expect(keepContextReport(db, 's1', { report: report(2) as any, takenAt: 1000, origin: READOUT })).toBe(false);
    expect(keptContextReport(db, 's1')).toEqual({ report: report(1), takenAt: 2000, origin: READOUT });
    expect(keepContextReport(db, 's1', { report: report(3) as any, takenAt: 3000, origin: READOUT })).toBe(true);
    expect(keptContextReport(db, 's1')?.report.totalTokens).toBe(3);
    expect(contextReportAt(db, 's1')).toBe(3000);
  });

  it('reads the newest /context twin on stdout, with its time', () => {
    expect(latestContextTwin([
      contextEntry('2026-11-19T10:00:00Z', 1),
      contextEntry('2026-11-19T11:00:00Z', 2),
      contextEntry('2026-11-19T12:00:00Z', 3, 'stderr'),
      { type: 'user', message: { content: 'hi' } },
    ])).toEqual({
      report: expect.objectContaining({ totalTokens: 2 }), takenAt: Date.parse('2026-11-19T11:00:00Z'),
      origin: { kind: 'transcript', uuid: 'u-2026-11-19T11:00:00Z' },
    });
    expect(latestContextTwin([{ type: 'user' }])).toBeNull();
  });

  it('is found by the indexer, loses to a newer one taken from the read-out, and goes with the sweep', () => {
    const dir = makeTmpDir('ctxr-idx');
    const projects = join(dir, 'projects');
    mkdirSync(join(projects, 'p'), { recursive: true });
    const db = openDb(join(dir, 'index.db'));
    const write = (entries: unknown[]) =>
      writeFileSync(join(projects, 'p', 's1.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n'));
    const user = { type: 'user', uuid: 'q1', timestamp: '2026-11-19T09:00:00Z', cwd: '/w', message: { role: 'user', content: 'hi' } };

    write([user, contextEntry('2026-11-19T10:00:00Z', 1)]);
    expect(indexPaths(db, projects, ['p/s1.jsonl']).reports).toEqual(['s1']);
    expect(keptContextReport(db, 's1')?.report.totalTokens).toBe(1);

    keepContextReport(db, 's1', { report: report(9), takenAt: Date.parse('2026-11-19T10:30:00Z'), origin: READOUT });
    write([user, contextEntry('2026-11-19T10:00:00Z', 1), { ...user, uuid: 'q2' }]);
    expect(indexPaths(db, projects, ['p/s1.jsonl']).reports).toEqual([]);
    expect(keptContextReport(db, 's1')?.report.totalTokens).toBe(9);

    db.update(sessions).set({ lastAt: 1 }).run();
    sweepSessions(db, retentionCutoff(1, Date.now()), Date.now());
    expect(keptContextReport(db, 's1')).toBeNull();
  });

  describe('through a rewind', () => {
    /** A transcript with a fork: `/context` at 10:00 on the first branch, the live one rewound to before it. */
    function setup() {
      const dir = makeTmpDir('ctxr-rw');
      const projects = join(dir, 'projects');
      mkdirSync(join(projects, 'p'), { recursive: true });
      const db = openDb(join(dir, 'index.db'));
      const write = (entries: unknown[]) =>
        writeFileSync(join(projects, 'p', 's1.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n'));
      const index = () => indexPaths(db, projects, ['p/s1.jsonl']).reports;
      const user = (uuid: string, parentUuid: string | null, timestamp: string) => ({
        type: 'user', uuid, parentUuid, timestamp, cwd: '/w', message: { role: 'user', content: uuid },
      });
      const atContext = (parentUuid: string, timestamp: string, totalTokens: number) =>
        ({ ...contextEntry(timestamp, totalTokens), parentUuid });
      return { db, write, index, user, atContext };
    }

    it('a typed /context follows the live branch, back to an older one or away', () => {
      const { db, write, index, user, atContext } = setup();
      const q1 = user('q1', null, '2026-11-19T09:00:00Z');
      const early = atContext('q1', '2026-11-19T09:30:00Z', 1);
      const asked = user('qd', early.uuid, '2026-11-19T09:45:00Z');
      const late = atContext('qd', '2026-11-19T10:00:00Z', 2);
      write([q1, early, asked, late]);
      expect(index()).toEqual(['s1']);
      expect(keptContextReport(db, 's1')?.report.totalTokens).toBe(2);

      // Rewound to just after the first /context: the newer one is off the branch.
      write([q1, early, asked, late, user('q2', early.uuid, '2026-11-19T11:00:00Z')]);
      expect(index()).toEqual(['s1']);
      expect(keptContextReport(db, 's1')).toMatchObject({ report: { totalTokens: 1 }, origin: { uuid: early.uuid } });

      // Rewound to before either: none is left on the branch.
      write([q1, early, asked, late, user('q2', early.uuid, '2026-11-19T11:00:00Z'), user('q3', 'q1', '2026-11-19T12:00:00Z')]);
      expect(index()).toEqual(['s1']);
      expect(keptContextReport(db, 's1')).toBeNull();
    });

    it('a report from the read-out stays until a rewind is sent after it, then the branch stands in', () => {
      const { db, write, index, user, atContext } = setup();
      const q1 = user('q1', null, '2026-11-19T09:00:00Z');
      const typed = atContext('q1', '2026-11-19T09:30:00Z', 1);
      write([q1, typed]);
      index();
      const readAt = Date.parse('2026-11-19T10:00:00Z');
      keepContextReport(db, 's1', { report: report(9), takenAt: readAt, origin: READOUT });

      write([q1, typed, user('q2', typed.uuid, '2026-11-19T10:30:00Z')]);
      expect(index()).toEqual([]);
      expect(keptContextReport(db, 's1')?.report.totalTokens).toBe(9);

      db.insert(rewinds).values({ sessionId: 's1', forkUuid: 'q1', targetUuid: 'q2', hiddenCount: 1, at: readAt + 1 }).run();
      write([q1, typed, user('q2', typed.uuid, '2026-11-19T10:30:00Z'), user('q3', typed.uuid, '2026-11-19T11:00:00Z')]);
      expect(index()).toEqual(['s1']);
      expect(keptContextReport(db, 's1')).toMatchObject({ report: { totalTokens: 1 }, origin: { kind: 'transcript' } });
    });
  });
});
