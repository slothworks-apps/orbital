import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  claudeDirEnv,
  normalizeClaudeDirPath,
  readAccountEmail,
  UNOWNED_CLAUDE_DIR_ID,
  validateClaudeDirPath,
} from '../src/claudeDirs/paths.js';
import { ClaudeDirsService, seedClaudeDirs } from '../src/claudeDirs/service.js';
import { claudeDirs, sessions, settings as settingsTable } from '../src/db/schema.js';
import type { OrbitalDb } from '../src/db/database.js';
import { buildServer } from '../src/index.js';
import { makeTmpDir, openTmpDb } from './tmp.js';

const HOME = '/Users/fixture';

describe('the environment a CLI runs under', () => {
  /**
   * The keychain item the CLI keeps its login in is named after the
   * variable's string once it is set, so the default directory must run with
   * the variable gone, not set to the default.
   */
  it('removes CLAUDE_CONFIG_DIR for the CLI default directory, even an inherited one', () => {
    const env = claudeDirEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/elsewhere' }, '/Users/fixture/.claude', HOME);
    expect(env).toEqual({ PATH: '/bin' });
    expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
  });

  it('sets any other directory as the stored string exactly, over an inherited value', () => {
    expect(claudeDirEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/elsewhere' }, '/Users/fixture/.claude-work', HOME))
      .toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/Users/fixture/.claude-work' });
  });

  it('builds a copy and leaves the base alone', () => {
    const base = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/elsewhere' };
    claudeDirEnv(base, '/w', HOME);
    expect(base).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/elsewhere' });
  });
});

describe('a typed directory path', () => {
  it('expands ~, drops a trailing slash and refuses a relative path', () => {
    expect(normalizeClaudeDirPath('~/.claude-work', HOME)).toBe('/Users/fixture/.claude-work');
    expect(normalizeClaudeDirPath('/x/.claude-work/', HOME)).toBe('/x/.claude-work');
    expect(normalizeClaudeDirPath('  ~/.claude-work/  ', HOME)).toBe('/Users/fixture/.claude-work');
    expect(normalizeClaudeDirPath('.claude-work', HOME)).toBeNull();
    expect(normalizeClaudeDirPath('   ', HOME)).toBeNull();
  });

  it('must exist, be a directory, and not be one already configured — symlinks included', () => {
    const root = makeTmpDir('claude-dirs');
    const work = join(root, 'work');
    mkdirSync(work);
    writeFileSync(join(root, 'file'), '');
    symlinkSync(work, join(root, 'link'));

    expect(validateClaudeDirPath(undefined, [])).toEqual({ ok: false, error: 'path_required' });
    expect(validateClaudeDirPath('relative', [])).toEqual({ ok: false, error: 'not_absolute' });
    expect(validateClaudeDirPath(join(root, 'missing'), [])).toEqual({ ok: false, error: 'no_such_directory' });
    expect(validateClaudeDirPath(join(root, 'file'), [])).toEqual({ ok: false, error: 'not_a_directory' });
    expect(validateClaudeDirPath(`${work}/`, [])).toEqual({ ok: true, path: work });
    expect(validateClaudeDirPath(`${work}/`, [work])).toEqual({ ok: false, error: 'duplicate' });
    expect(validateClaudeDirPath(join(root, 'link'), [work])).toEqual({ ok: false, error: 'duplicate' });
    // A configured directory gone from disk still blocks its own spelling.
    expect(validateClaudeDirPath(work, [join(root, 'gone'), join(root, 'link')]))
      .toEqual({ ok: false, error: 'duplicate' });
  });
});

describe('the account of a directory', () => {
  it('reads oauthAccount.emailAddress, and is null for anything else', () => {
    const home = makeTmpDir('claude-home');
    const work = join(home, '.claude-work');
    mkdirSync(work);
    writeFileSync(join(work, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@work.example' } }));
    writeFileSync(join(home, '.claude.json'), '{ half-written');
    expect(readAccountEmail(work, home)).toBe('me@work.example');
    // The CLI's default directory keeps its config in the home directory.
    expect(readAccountEmail(join(home, '.claude'), home)).toBeNull();
    expect(readAccountEmail(join(home, 'nowhere'), home)).toBeNull();
    writeFileSync(join(work, '.claude.json'), JSON.stringify({ oauthAccount: {} }));
    expect(readAccountEmail(work, home)).toBeNull();
  });
});

function setting(db: OrbitalDb, key: string): string | undefined {
  return db.select({ value: settingsTable.value }).from(settingsTable).where(eq(settingsTable.key, key)).get()?.value;
}

describe('seeding the first directory', () => {
  it('takes the retired claude_directory setting, ~ expanded, and drops it', () => {
    const db = openTmpDb('seed');
    db.insert(settingsTable).values({ key: 'claude_directory', value: '~/.claude-old/' }).run();
    seedClaudeDirs(db, { home: HOME, now: 5 });
    expect(db.select().from(claudeDirs).all())
      .toEqual([{ id: 1, name: 'Personal', path: '/Users/fixture/.claude-old', createdAt: 5 }]);
    expect(setting(db, 'claude_directory')).toBeUndefined();
  });

  it('falls back to ~/.claude, and seeds nothing once a row exists', () => {
    const db = openTmpDb('seed');
    seedClaudeDirs(db, { home: HOME });
    db.update(claudeDirs).set({ name: 'Mine' }).run();
    seedClaudeDirs(db, { home: HOME });
    expect(db.select({ name: claudeDirs.name, path: claudeDirs.path }).from(claudeDirs).all())
      .toEqual([{ name: 'Mine', path: '/Users/fixture/.claude' }]);
  });
});

function service(db: OrbitalDb, override?: string) {
  const store = new Map<string, string>();
  const started: number[] = [];
  const stopped: number[] = [];
  const hidden: string[][] = [];
  seedClaudeDirs(db, { home: HOME });
  const dirs = new ClaudeDirsService({
    db, override, home: HOME,
    settings: { get: (k) => store.get(k) ?? '', set: (k, v) => void store.set(k, v) },
    startContext: (dir) => {
      started.push(dir.id);
      return { stop: () => stopped.push(dir.id) };
    },
    onHidden: (ids) => hidden.push(ids),
  });
  dirs.start();
  return { dirs, store, started, stopped, hidden };
}

describe('a second directory copied from the first', () => {
  const nextTick = () => new Promise((resolve) => setImmediate(resolve));

  /**
   * Copying `~/.claude` is the natural way to make a work directory, and it
   * brings every transcript along: the copies stay the first directory's,
   * and the log says so once, not once per transcript.
   */
  it('leaves the sessions with the first and records the collision once', async () => {
    const personal = makeTmpDir('personal');
    const project = join(personal, 'projects', 'proj');
    mkdirSync(project, { recursive: true });
    const fixture = readFileSync(join(import.meta.dirname, 'fixtures/transcript-basic.jsonl'), 'utf8');
    writeFileSync(join(project, 'one.jsonl'), fixture);
    writeFileSync(join(project, 'two.jsonl'), fixture);
    const app = await buildServer({ dbPath: join(personal, 'index.db'), claudeDir: personal, queryFn: (() => {}) as any });
    try {
      await nextTick();
      const work = join(makeTmpDir('work'), '.claude-work');
      cpSync(personal, work, { recursive: true });
      const added = await app.inject({ method: 'POST', url: '/api/claude-dirs', payload: { name: 'Work', path: work } });
      expect(added.statusCode).toBe(201);
      await nextTick();
      const listed = (await app.inject({ method: 'GET', url: '/api/sessions' })).json().sessions;
      expect(listed.map((s: { id: string; claudeDirId: number }) => [s.id, s.claudeDirId]).sort())
        .toEqual([['one', 1], ['two', 1]]);
      const logged = (await app.inject({ method: 'GET', url: '/api/errors' })).json().errors
        .filter((e: { kind: string }) => e.kind === 'session_id_collision');
      expect(logged).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe('the directories service', () => {
  it('lets the environment override the first directory, and says so', () => {
    const { dirs } = service(openTmpDb('dirs'), '~/.claude-env');
    expect(dirs.list()).toEqual([
      { id: 1, name: 'Personal', path: '/Users/fixture/.claude-env', overriddenByEnv: true },
    ]);
  });

  it('adds, defaults, refuses an unknown id, and never removes the last directory', () => {
    const db = openTmpDb('dirs');
    const { dirs, store, started, stopped } = service(db);
    const work = makeTmpDir('work');
    const added = dirs.add({ name: ' Work ', path: work });
    expect(added).toEqual({ ok: true, dir: { id: 2, name: 'Work', path: work, overriddenByEnv: false } });
    expect(started).toEqual([1, 2]);
    expect(dirs.resolveId(undefined)).toBe(1);
    expect(dirs.resolveId('2')).toBe(2);
    expect(dirs.resolveId(7)).toBeNull();
    expect(dirs.resolveId('x')).toBeNull();

    store.set('default_claude_dir', '2');
    expect(dirs.remove(2)).toEqual({ ok: true });
    expect(stopped).toEqual([2]);
    // The default moved to a directory that is still there.
    expect(dirs.defaultId()).toBe(1);
    expect(dirs.remove(1)).toEqual({ ok: false, error: 'last_directory' });
  });

  it('hides a moved directory\'s sessions until a directory indexes them again', () => {
    const db = openTmpDb('dirs');
    const { dirs, started, hidden } = service(db);
    const first = makeTmpDir('first');
    const second = makeTmpDir('second');
    const work = dirs.add({ name: 'Work', path: first });
    if (!work.ok) throw new Error('not added');
    db.insert(sessions).values({ id: 's1', projectDir: 'p', claudeDirId: work.dir.id }).run();
    expect(dirs.update(work.dir.id, { name: 'Job' })).toMatchObject({ ok: true, dir: { name: 'Job', path: first } });
    expect(hidden).toEqual([]);
    expect(dirs.update(work.dir.id, { path: second })).toMatchObject({ ok: true, dir: { path: second } });
    expect(hidden).toEqual([['s1']]);
    expect(started).toEqual([1, 2, 2]);
    expect(db.select({ dir: sessions.claudeDirId }).from(sessions).get()?.dir).toBe(UNOWNED_CLAUDE_DIR_ID);
  });
});
