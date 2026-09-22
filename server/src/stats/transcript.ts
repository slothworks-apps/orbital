import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseTranscript, type TranscriptEntry } from '../transcript/parser.js';

/** Where the CLI puts a session's sidechains, relative to the session file. */
const SUBAGENT_DIR = 'subagents';
const SUBAGENT_FILE = /^agent-.*\.jsonl$/;

/**
 * The sidechain entries the CLI wrote beside a session transcript, in
 * `<session-id>/subagents/agent-*.jsonl` — on the current CLI they are not in
 * the session file at all (`docs/domains/subagents-in-transcripts.md`), so a
 * stats pass that reads only the session file reports no subagent tokens
 * whatsoever. Missing or unreadable files yield nothing rather than throwing:
 * a session without subagents has no such directory, which is the common case.
 */
export function readSubagentEntries(transcriptPath: string): TranscriptEntry[] {
  const dir = join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), SUBAGENT_DIR);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => SUBAGENT_FILE.test(f)).sort();
  } catch {
    return [];
  }
  const entries: TranscriptEntry[] = [];
  for (const file of files) {
    try {
      entries.push(...parseTranscript(readFileSync(join(dir, file), 'utf8')));
    } catch {
      // One agent's file being unreadable costs that agent's tokens, not the
      // whole session's stats.
    }
  }
  return entries;
}

/**
 * Everything `computeStats` needs for one session: its own transcript first,
 * then its sidechains. `computeStats` keys on `isSidechain` rather than on
 * which file a line came from, so the concatenation needs no marking — but the
 * session's own entries stay in write order, which is what the turn and tool
 * pairing reads. Throws if the session transcript itself cannot be read.
 */
export function readSessionEntries(transcriptPath: string): TranscriptEntry[] {
  return [
    ...parseTranscript(readFileSync(transcriptPath, 'utf8')),
    ...readSubagentEntries(transcriptPath),
  ];
}
