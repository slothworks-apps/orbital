import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { fileSandboxes, sessionTranscriptFiles } from '../files/preview.js';
import { fileStamp, StampedCache } from '../transcript/stampedCache.js';
import { subagentDirOf } from '../walkthrough/subagents.js';
import type { SubagentInfo } from '../transcript/subagents.js';
import type { SessionRow } from '../types.js';
import type { GitLocation } from './gitState.js';
import type { GitStore } from './store.js';

/** How much of a transcript one step reads, going back from its end for the last `cwd`. */
const TAIL_CHUNK_BYTES = 64 * 1024;
/** How much of a transcript one step reads, going forward to collect every `cwd`. */
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
/** How many transcripts' last `cwd` are held. Each value is one short string. */
const LAST_CWD_CACHE_FILES = 4096;

const CWD_KEY = Buffer.from('"cwd":');
const NEWLINE = 0x0a;
/** A `cwd` key with its JSON string value, wherever it sits in a line. */
const CWD_VALUE = /"cwd":"((?:[^"\\]|\\.)*)"/g;
/** A subagent's meta file, beside its transcript. */
const META_FILE = /^(agent-[\w-]+)\.meta\.json$/;
/** What an agent id must look like before it is joined onto a path. */
const AGENT_ID = /^[\w-]+$/;

/**
 * The `cwd` an entry ran in: the top-level field of one transcript line.
 * Parsed rather than matched, because a tool's input can carry a `cwd` key
 * of its own, and only the entry's says where the agent was. A line still
 * being written does not parse and names nothing.
 */
function cwdOfLine(line: Buffer): string | null {
  if (line.indexOf(CWD_KEY) === -1) return null;
  try {
    const entry = JSON.parse(line.toString('utf8')) as { cwd?: unknown };
    return typeof entry.cwd === 'string' && entry.cwd ? entry.cwd : null;
  } catch {
    return null;
  }
}

/**
 * The last `cwd` a transcript recorded, or null when it has none (or cannot
 * be read). Reads back from the end a chunk at a time: the CLI stamps every
 * entry, so the answer is almost always in the first chunk, and only a
 * transcript whose tail is all bookkeeping lines reads further.
 */
export function readLastCwd(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    let end = fstatSync(fd).size;
    // The start of a line that began before the chunk just read.
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const text = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let lineEnd = text.length;
      for (let i = text.length - 1; i >= 0; i--) {
        if (text[i] !== NEWLINE) continue;
        const cwd = cwdOfLine(text.subarray(i + 1, lineEnd));
        if (cwd) return cwd;
        lineEnd = i;
      }
      carry = text.subarray(0, lineEnd);
      end = start;
    }
    return cwdOfLine(carry);
  } finally {
    closeSync(fd);
  }
}

/** One transcript's `cwd`s so far, and how far into the file they were read. */
interface CwdScan {
  offset: number;
  cwds: Set<string>;
}

/**
 * Adds the entry's `cwd` from one line. Every entry repeats the `cwd` of the
 * one before it, so the values are matched first and the line is parsed only
 * when one of them is new — which is what keeps a scan of a long transcript
 * from parsing every line of it.
 */
function addLineCwd(line: Buffer, into: Set<string>): void {
  if (line.indexOf(CWD_KEY) === -1) return;
  const text = line.toString('utf8');
  for (const match of text.matchAll(CWD_VALUE)) {
    let value: unknown;
    try {
      value = JSON.parse(`"${match[1]}"`);
    } catch {
      continue;
    }
    if (typeof value === 'string' && into.has(value)) continue;
    const cwd = cwdOfLine(line);
    if (cwd) into.add(cwd);
    return;
  }
}

/**
 * Every `cwd` a transcript recorded, continuing from `prev`: the CLI only
 * appends, so what was read stays read. A file that shrank was rewritten
 * and is read again from the start. A line not finished yet is left for the
 * next call.
 */
function scanCwds(path: string, prev: CwdScan | undefined): CwdScan {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return prev ?? { offset: 0, cwds: new Set() };
  }
  try {
    const size = fstatSync(fd).size;
    const scan = prev && prev.offset <= size ? prev : { offset: 0, cwds: new Set<string>() };
    let pos = scan.offset;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const chunk = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, size - pos));
      const read = readSync(fd, chunk, 0, chunk.length, pos);
      if (read === 0) break;
      pos += read;
      const text = carry.length ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      let lineStart = 0;
      for (let nl = text.indexOf(NEWLINE); nl !== -1; nl = text.indexOf(NEWLINE, lineStart)) {
        addLineCwd(text.subarray(lineStart, nl), scan.cwds);
        lineStart = nl + 1;
      }
      carry = text.subarray(lineStart);
    }
    scan.offset = pos - carry.length;
    return scan;
  } finally {
    closeSync(fd);
  }
}

/**
 * The `toolUseId` a subagent's meta file names, null when it names none, or
 * undefined when the file cannot be read yet.
 */
function readMetaToolUseId(path: string): string | null | undefined {
  try {
    const meta = JSON.parse(readFileSync(path, 'utf8')) as { toolUseId?: unknown };
    return typeof meta.toolUseId === 'string' && meta.toolUseId ? meta.toolUseId : null;
  } catch {
    return undefined;
  }
}

/** A working tree that running subagents work in, other than the session's own. */
export interface OtherTree {
  /** The tree's root, or the agents' `cwd` itself when it is outside any repository. */
  root: string;
  git: GitLocation | null;
  /** The running subagents in it, by `SubagentInfo.name`, the most recently started first. */
  agents: string[];
}

/** Where a session works now, as its shape carries it. */
export interface SessionPlaces {
  workingDir: string;
  otherTrees: OtherTree[];
}

/** The row fields the readings need. */
export type TreeRow = Pick<SessionRow, 'id' | 'cwd' | 'project_dir' | 'claude_dir_id'>;

/**
 * Where each session works now, read from its transcripts (adr
 * `a-session-has-a-home-and-a-working-tree`): the last `cwd` of the main
 * transcript, and of each running subagent's own, resolved to working-tree
 * roots through `GitStore`. Kept in memory and never written down; a restart
 * reads it again from the files.
 *
 * Every reading is held under its file's stamp, so shaping a session whose
 * transcripts did not move costs a `stat` per file.
 */
export class WorkingTrees {
  private lastCwds = new StampedCache<string | null>(LAST_CWD_CACHE_FILES);
  /** Every `cwd` per transcript file, for the file viewer's `cwd` check. */
  private scans = new Map<string, CwdScan>();
  /** Meta file → the `toolUseId` it names. The CLI writes a meta file once. */
  private metaToolUseIds = new Map<string, string | null>();
  /** What each session was last shaped with, so `moved` can tell a change from a repeat. */
  private shaped = new Map<string, { key: string; dirs: string[] }>();

  constructor(private readonly opts: {
    /** A session's transcript file, under its own Claude directory's `projects/`. */
    transcriptPath: (sessionId: string, projectDir: string, claudeDirId: number) => string;
    git: Pick<GitStore, 'rootOf' | 'locate'>;
  }) {}

  /** The session's main transcript. */
  transcriptOf(row: TreeRow): string {
    return this.opts.transcriptPath(row.id, row.project_dir, row.claude_dir_id);
  }

  /** The last `cwd` a transcript file recorded, or null. */
  lastCwdOf(path: string): string | null {
    const stamp = fileStamp(path);
    if (stamp === null) return null;
    return this.lastCwds.get(path, stamp, () => readLastCwd(path));
  }

  /** The `cwd` the session's main transcript recorded last, or null before it recorded one. */
  currentCwd(row: TreeRow): string | null {
    return this.lastCwdOf(this.transcriptOf(row));
  }

  /** The working tree a directory sits in, or the directory itself outside any repository. */
  private treeOf(cwd: string): string {
    return this.opts.git.rootOf(cwd) ?? cwd;
  }

  /**
   * The root of the tree the session works in now, or its current `cwd`
   * outside a repository. The home itself while the session is still in the
   * home's tree, so a session started in a subdirectory keeps showing that
   * subdirectory, and a `cd` inside the tree moves nothing.
   */
  workingDir(row: TreeRow): string {
    const current = this.currentCwd(row);
    if (current === null || current === row.cwd) return row.cwd;
    const tree = this.treeOf(current);
    return tree === this.treeOf(row.cwd) ? row.cwd : tree;
  }

  /**
   * The trees the session's running subagents work in, minus its own,
   * grouped by tree and the tree with the most recently started agent first.
   * An agent whose transcript cannot be found, or has no `cwd` yet, has no
   * tree and does not count.
   */
  otherTrees(row: TreeRow, workingDir: string, agents: SubagentInfo[]): OtherTree[] {
    const running = agents.filter((a) => a.state === 'working');
    if (running.length === 0) return [];
    const own = this.treeOf(workingDir);
    const dir = subagentDirOf(this.transcriptOf(row));
    const byTree = new Map<string, SubagentInfo[]>();
    for (const agent of running) {
      const file = this.agentFile(dir, agent);
      const cwd = file && this.lastCwdOf(file);
      if (!cwd) continue;
      const tree = this.treeOf(cwd);
      if (tree === own) continue;
      const list = byTree.get(tree);
      if (list) list.push(agent);
      else byTree.set(tree, [agent]);
    }
    const newestFirst = (a: SubagentInfo, b: SubagentInfo) => b.startedAt - a.startedAt;
    return [...byTree]
      .map(([root, list]) => ({ root, list: list.sort(newestFirst) }))
      .sort((a, b) => newestFirst(a.list[0], b.list[0]))
      .map(({ root, list }) => ({ root, git: this.opts.git.locate(root), agents: list.map((a) => a.name) }));
  }

  /**
   * Both readings for the shape, remembered for `moved` and `sessionsAt`.
   * An ended session has no running subagents to place, whatever its tracker
   * last heard.
   */
  places(row: TreeRow, agents: SubagentInfo[], ended: boolean): SessionPlaces {
    const workingDir = this.workingDir(row);
    const otherTrees = ended ? [] : this.otherTrees(row, workingDir, agents);
    this.shaped.set(row.id, {
      key: JSON.stringify([workingDir, otherTrees.map((t) => [t.root, t.agents])]),
      dirs: [workingDir, ...otherTrees.map((t) => t.root)],
    });
    return { workingDir, otherTrees };
  }

  /**
   * Whether the session's places changed since it was last shaped. A session
   * never shaped has been shown to nobody, so nothing about it is stale.
   */
  moved(row: TreeRow, agents: SubagentInfo[], ended: boolean): boolean {
    const before = this.shaped.get(row.id)?.key;
    this.places(row, agents, ended);
    return before !== undefined && before !== this.shaped.get(row.id)!.key;
  }

  /** Every session shaped so far — what an event that named no transcript could have moved. */
  shapedSessions(): string[] {
    return [...this.shaped.keys()];
  }

  /**
   * The sessions last shaped as working in one of these directories, their
   * own tree or a subagent's — what a `HEAD` change there has to republish
   * beside the sessions whose home it is.
   */
  sessionsAt(cwds: string[]): string[] {
    const wanted = new Set(cwds);
    const ids: string[] = [];
    for (const [id, { dirs }] of this.shaped) {
      if (dirs.some((d) => wanted.has(d))) ids.push(id);
    }
    return ids;
  }

  /** Every `cwd` the session's main transcript and its subagents' transcripts recorded. */
  recordedCwds(row: TreeRow): Set<string> {
    const all = new Set<string>();
    for (const path of sessionTranscriptFiles(this.transcriptOf(row))) {
      const scan = scanCwds(path, this.scans.get(path));
      this.scans.set(path, scan);
      for (const cwd of scan.cwds) all.add(cwd);
    }
    return all;
  }

  /** Where a file request for this session is confined, in the order to try them (`fileSandboxes`). */
  sandboxes(row: TreeRow, requested: string | undefined): string[] {
    return fileSandboxes(row.cwd, this.workingDir(row), requested, () => this.recordedCwds(row));
  }

  /** The `cwd` a subagent's transcript recorded last, by the `Agent` call that launched it, or null. */
  agentCwd(row: TreeRow, agent: SubagentInfo): string | null {
    const file = this.agentFile(subagentDirOf(this.transcriptOf(row)), agent);
    return file && this.lastCwdOf(file);
  }

  /**
   * A subagent's transcript: `agent-<id>.jsonl` when the tracker's id is the
   * CLI's agent id, otherwise the file whose meta names the agent's
   * `toolUseId` — which is the id itself for an agent read off a transcript.
   */
  private agentFile(dir: string, agent: SubagentInfo): string | null {
    if (AGENT_ID.test(agent.id)) {
      const direct = join(dir, `agent-${agent.id}.jsonl`);
      if (fileStamp(direct) !== null) return direct;
    }
    const toolUseId = agent.toolUseId ?? agent.id;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    for (const name of names) {
      const m = META_FILE.exec(name);
      if (!m) continue;
      const metaPath = join(dir, name);
      let named = this.metaToolUseIds.get(metaPath);
      if (named === undefined) {
        named = readMetaToolUseId(metaPath);
        if (named === undefined) continue;
        this.metaToolUseIds.set(metaPath, named);
      }
      if (named === toolUseId) return join(dir, `${m[1]}.jsonl`);
    }
    return null;
  }
}
