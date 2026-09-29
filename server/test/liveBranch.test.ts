import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BranchFollower, liveBranch, readBranch } from '../src/transcript/liveBranch.js';
import { entriesToMessages, parseTranscript, type TranscriptEntry } from '../src/transcript/parser.js';

/**
 * A throwaway haiku session from the rewind spike (spec
 * 2026-09-29-rewind-design § Verification), payloads trimmed: prompts A–C,
 * then SDK rewinds to D (off B), E (off A), F (off E, dropping "which
 * letters"), a `/compact`, G, and I (off the compaction, dropping G).
 */
const cliRewind = parseTranscript(
  readFileSync(join(import.meta.dirname, 'fixtures/transcript-rewind-cli.jsonl'), 'utf8'),
);

const prompt = (uuid: string, parent: string | null, text = uuid): TranscriptEntry => ({
  type: 'user', uuid, parentUuid: parent, message: { role: 'user', content: text },
});
const says = (uuid: string, parent: string | null, text = uuid): TranscriptEntry => ({
  type: 'assistant', uuid, parentUuid: parent, requestId: `req-${uuid}`,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const calls = (uuid: string, parent: string | null, toolUseId: string, requestId = `req-${uuid}`): TranscriptEntry => ({
  type: 'assistant', uuid, parentUuid: parent, requestId,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: {} }] },
});
const result = (uuid: string, parent: string, toolUseId: string): TranscriptEntry => ({
  type: 'user', uuid, parentUuid: parent,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
});
const hook = (uuid: string, parent: string): TranscriptEntry => ({
  type: 'attachment', uuid, parentUuid: parent,
});
const system = (uuid: string, parent: string, subtype = 'stop_hook_summary'): TranscriptEntry => ({
  type: 'system', subtype, uuid, parentUuid: parent,
});

const uuids = (entries: TranscriptEntry[]) => entries.map((e) => e.uuid ?? `(${e.type})`);

describe('liveBranch', () => {
  it('reads a CLI rewind as the newest branch only', () => {
    const users = entriesToMessages(liveBranch(cliRewind))
      .filter((m) => m.role === 'user' && m.text)
      .map((m) => m.text);
    expect(users).toEqual([
      'say A (reply with just the letter)',
      'say E (reply with just the letter)',
      'say F (reply with just the letter)',
      'say I (reply with just the letter)',
    ]);
  });

  it('crosses a compaction by its logical parent', () => {
    const roles = entriesToMessages(liveBranch(cliRewind)).map((m) => m.role);
    // The compaction mark sits between F's answer and I, and everything
    // before it is still there.
    expect(roles.indexOf('compaction')).toBeGreaterThan(roles.indexOf('assistant'));
    expect(roles.filter((r) => r === 'assistant')).toHaveLength(4);
  });

  it('keeps the metadata entries that carry no uuid', () => {
    const live = liveBranch(cliRewind);
    const chainless = (list: TranscriptEntry[]) => list.filter((e) => typeof e.uuid !== 'string');
    expect(chainless(live)).toEqual(chainless(cliRewind));
  });

  it('names each fork the live branch passes, and only those', () => {
    const { forks } = readBranch(cliRewind);
    // B, "which letters" and G were dropped on the way to the newest leaf;
    // C and D were dropped too, but off a branch that is itself dead.
    expect(forks).toEqual([
      { parentUuid: '09dab896-f23d-470a-8058-1bf50b5880a0', deadUuid: '84f96182-559a-49fa-92ff-720dedcc8c7d' },
      { parentUuid: '4801b86f-282e-426b-bfbd-563686811f39', deadUuid: 'a687abae-f738-4b83-841d-d540ed492c26' },
      { parentUuid: '0fce1598-7eb2-4f22-85ce-056a0a3b4ae7', deadUuid: '0224a5d5-2ac8-4dbe-9386-9ca31dccdc19' },
    ]);
  });

  it('drops the dangling tool_use an interrupt leaves once the next prompt is in', () => {
    const entries = [
      prompt('p1', null),
      says('a1', 'p1'),
      calls('a2', 'a1', 'tu-dangling'),
      hook('h1', 'a2'),
      // The next prompt parents to the block before the call.
      prompt('p2', 'a1'),
      says('a3', 'p2'),
    ];
    const branch = readBranch(entries);
    expect(uuids(branch.entries)).toEqual(['p1', 'a1', 'p2', 'a3']);
    // No prompt was dropped: this is no rewind.
    expect(branch.forks).toEqual([]);
  });

  it('keeps an unanswered call of a batch still running', () => {
    const entries = [
      prompt('p1', null),
      calls('a1', 'p1', 'tu-a', 'req-1'),
      calls('a2', 'a1', 'tu-b', 'req-1'),
      result('r1', 'a1', 'tu-a'),
    ];
    expect(uuids(liveBranch(entries))).toEqual(['p1', 'a1', 'a2', 'r1']);
  });

  it('keeps every call and result of a parallel batch, whichever result landed last', () => {
    // As the CLI writes it: the calls chained one after the other, each
    // result parented to its own call, and the next step off the last result.
    const entries = [
      prompt('p1', null),
      calls('a1', 'p1', 'tu-a', 'req-1'),
      calls('a2', 'a1', 'tu-b', 'req-1'),
      hook('h1', 'a2'),
      result('rb', 'a2', 'tu-b'),
      hook('h2', 'rb'),
      result('ra', 'a1', 'tu-a'),
      hook('h3', 'ra'),
      says('a3', 'h3'),
    ];
    expect(uuids(liveBranch(entries))).toEqual(['p1', 'a1', 'a2', 'h1', 'rb', 'h2', 'ra', 'h3', 'a3']);
  });

  it('takes the first occurrence of a re-appended uuid, and does not let the copy take the tip', () => {
    const entries = [
      prompt('p1', null),
      says('a1', 'p1'),
      hook('h1', 'a1'),
      prompt('p2', 'a1'),
      says('a2', 'p2'),
      // A range re-appended around a compaction: h1 is a leaf, and ranked by
      // its copy it would be the newest one.
      { ...says('a1', 'p1'), timestamp: 'copy' },
      { ...hook('h1', 'a1'), timestamp: 'copy' },
    ];
    const live = liveBranch(entries);
    expect(uuids(live)).toEqual(['p1', 'a1', 'h1', 'p2', 'a2']);
    expect(live.some((e) => e.timestamp === 'copy')).toBe(false);
  });

  it('drops the /compact prompt older transcripts hang off the pre-compaction tip, without calling it a fork', () => {
    const entries: TranscriptEntry[] = [
      prompt('p1', null),
      says('a1', 'p1'),
      prompt('compact', 'a1', '/compact'),
      { type: 'system', subtype: 'compact_boundary', uuid: 'b1', parentUuid: null, logicalParentUuid: 'a1' },
      { ...prompt('s1', 'b1', 'summary'), isCompactSummary: true },
      prompt('p2', 's1'),
    ];
    const branch = readBranch(entries);
    expect(uuids(branch.entries)).toEqual(['p1', 'a1', 'b1', 's1', 'p2']);
    expect(branch.forks).toEqual([]);
  });

  it('walks past a parent the file never wrote', () => {
    const entries = [prompt('p1', null), says('a1', 'p1'), says('a2', 'never-written'), prompt('p2', 'a2')];
    expect(uuids(liveBranch(entries))).toEqual(['p1', 'a1', 'a2', 'p2']);
  });

  it('passes sidechain entries through untouched', () => {
    const side = { ...says('x1', null), isSidechain: true };
    expect(liveBranch([prompt('p1', null), side, says('a1', 'p1')])).toContain(side);
  });
});

describe('BranchFollower', () => {
  it('asks for a reload exactly where the CLI rewound', () => {
    const follower = new BranchFollower();
    const resets: string[] = [];
    for (const e of cliRewind) {
      if (follower.append([e]).kind === 'reset') resets.push(e.uuid ?? '');
    }
    // The new prompts D, E, F and I; the compaction is no branch change.
    expect(resets).toEqual([
      '4de1528c-375b-4050-892e-08fc4c4e3f88',
      '6db42e8b-8c6d-4f2a-b7e9-12c368a456e3',
      '0719f3ba-cbe1-414b-8ef5-e35e6ca8a26f',
      '7783630b-c101-42fa-b53e-77bfb1e51ecb',
    ]);
  });

  it('appends a parallel batch entry by entry without a reload', () => {
    const follower = new BranchFollower([prompt('p1', null)]);
    const batch = [
      calls('a1', 'p1', 'tu-a', 'req-1'),
      calls('a2', 'a1', 'tu-b', 'req-1'),
      result('rb', 'a2', 'tu-b'),
      result('ra', 'a1', 'tu-a'),
      says('a3', 'ra'),
    ];
    const out = batch.map((e) => follower.append([e]));
    expect(out.every((r) => r.kind === 'append')).toBe(true);
    expect(out.flatMap((r) => (r.kind === 'append' ? uuids(r.entries) : []))).toEqual(['a1', 'a2', 'rb', 'ra', 'a3']);
  });

  it('reloads for a rewind whose new branch opens with a system entry', () => {
    const follower = new BranchFollower([
      prompt('p1', null), says('a1', 'p1'), system('s1', 'a1'), prompt('p2', 's1'), says('a2', 'p2'),
    ]);
    // Seen on a real transcript: the CLI's away summary opens the new branch,
    // and it is already the newest leaf.
    expect(follower.append([system('away', 's1', 'away_summary')])).toEqual({ kind: 'reset' });
    expect(follower.append([prompt('p2-edited', 'away')]).kind).toBe('append');
  });

  it('reloads when the next prompt leaves an interrupted call behind', () => {
    const follower = new BranchFollower([prompt('p1', null), says('a1', 'p1'), calls('a2', 'a1', 'tu-x')]);
    expect(follower.append([prompt('p2', 'a1')])).toEqual({ kind: 'reset' });
    // After the reload the follower holds the new branch and carries on.
    expect(follower.append([says('a3', 'p2')])).toEqual({ kind: 'append', entries: [says('a3', 'p2')] });
  });

  it('passes chainless entries through with the ones it appends', () => {
    const follower = new BranchFollower([prompt('p1', null)]);
    const meta: TranscriptEntry = { type: 'last-prompt' };
    expect(follower.append([says('a1', 'p1'), meta])).toEqual({ kind: 'append', entries: [says('a1', 'p1'), meta] });
  });

  // Not the spec's "ignored": the newest leaf is the live one, so an append
  // to an abandoned branch takes the transcript back there, and the follower
  // agrees with what a full read now returns.
  it('reloads when an abandoned branch is continued', () => {
    const follower = new BranchFollower([prompt('p1', null), says('a1', 'p1'), prompt('p2', 'a1'), prompt('p3', 'a1')]);
    expect(follower.append([says('late', 'p2')])).toEqual({ kind: 'reset' });
  });

  it('puts a result written before its call after the call', () => {
    const follower = new BranchFollower([prompt('p1', null)]);
    const out = follower.append([result('r1', 'a1', 'tu-a'), calls('a1', 'p1', 'tu-a'), says('a2', 'r1')]);
    expect(out.kind === 'append' && uuids(out.entries)).toEqual(['a1', 'r1', 'a2']);
  });
});
