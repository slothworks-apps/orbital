// linux/update's channel handling: which suite the channel file names, and
// how the apt source is switched. The script is sourced for its functions
// (ORBITAL_UPDATE_FUNCTIONS_ONLY), its paths are pointed into a temporary
// directory, and runuser and timeout are stood in for by shell functions
// that run the command as is, so none of this needs root.
/* global URL, process */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const UPDATE = fileURLToPath(new URL('../linux/update', import.meta.url))
const root = process.getuid?.() === 0
const dirs = []
after(() => {
  for (const d of dirs) {
    chmodSync(d, 0o700)
    rmSync(d, { recursive: true, force: true })
  }
})

const SOURCE_TEXT = (suite) =>
  `Types: deb\nURIs: https://orbital.slothworks.io/apt\nSuites: ${suite}\nComponents: main\nSigned-By: /usr/share/keyrings/orbital.gpg\n`

/** A fresh machine: the user file names this user; channel and source as given. */
function machine({ channel, source = SOURCE_TEXT('stable') } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orbital-update-'))
  dirs.push(dir)
  const paths = {
    CHANNEL: join(dir, 'channel'),
    SOURCE: join(dir, 'orbital.sources'),
    USER_FILE: join(dir, 'user'),
    dir,
  }
  writeFileSync(paths.USER_FILE, `${userInfo().username}\n`)
  if (channel !== undefined) writeFileSync(paths.CHANNEL, channel)
  if (source !== null) writeFileSync(paths.SOURCE, source)
  return paths
}

/** Sources the script, points it at `paths`, runs `body`; extra shell before it in `prelude`. */
function run(paths, body, prelude = '') {
  const script = `
ORBITAL_UPDATE_FUNCTIONS_ONLY=1 . "$UPDATE"
set +e
CHANNEL="$T_CHANNEL"; SOURCE="$T_SOURCE"; USER_FILE="$T_USER_FILE"
timeout() { shift 3; "$@"; }
runuser() { shift 3; "$@"; }
${prelude}
${body}
`
  const r = spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      UPDATE,
      T_CHANNEL: paths.CHANNEL,
      T_SOURCE: paths.SOURCE,
      T_USER_FILE: paths.USER_FILE,
    },
  })
  return { out: r.stdout.trim(), err: r.stderr, status: r.status }
}

const suite = (paths) => run(paths, 'wanted_suite').out
const apply = (paths, prelude) => run(paths, 'apply_channel; echo "rc=$?"', prelude)

test('the exact word, with or without one newline, is experimental', { skip: root }, () => {
  assert.equal(suite(machine({ channel: 'experimental' })), 'experimental')
  assert.equal(suite(machine({ channel: 'experimental\n' })), 'experimental')
})

test('anything else is stable', () => {
  assert.equal(suite(machine({ channel: 'stable\n' })), 'stable')
  assert.equal(suite(machine({ channel: 'experimental\n\n' })), 'stable')
  assert.equal(suite(machine({ channel: 'experimental x' })), 'stable')
  assert.equal(suite(machine({ channel: ' experimental' })), 'stable')
  assert.equal(suite(machine({ channel: 'experimentalexperimental' })), 'stable')
  assert.equal(suite(machine({ channel: '' })), 'stable')
})

test('a missing channel file is stable', () => {
  assert.equal(suite(machine()), 'stable')
})

test('a symlink is stable, even to the word', () => {
  const m = machine()
  const target = join(m.dir, 'elsewhere')
  writeFileSync(target, 'experimental\n')
  symlinkSync(target, m.CHANNEL)
  assert.equal(suite(m), 'stable')
})

test('without a plain service user the file is not read', { skip: root }, () => {
  for (const user of ['', '-rf\n', 'a b\n', 'x;id\n', 'no-such-user-orbital-test\n', 'root\n']) {
    const m = machine({ channel: 'experimental\n' })
    writeFileSync(m.USER_FILE, user)
    assert.equal(suite(m), 'stable', JSON.stringify(user))
  }
})

test('a failed read is stable', { skip: root }, () => {
  const m = machine({ channel: 'experimental\n' })
  assert.equal(run(m, 'wanted_suite', 'runuser() { return 1; }').out, 'stable')
})

test('the switch rewrites only the Suites line and answers 0', { skip: root }, () => {
  const m = machine({ channel: 'experimental\n' })
  const r = apply(m)
  assert.match(r.out, /rc=0$/)
  assert.equal(readFileSync(m.SOURCE, 'utf8'), SOURCE_TEXT('experimental'))
  assert.deepEqual(readdirSync(m.dir).sort(), ['channel', 'orbital.sources', 'user'])
})

test('a source already on the suite is left alone and answers 1', () => {
  const m = machine({ channel: 'stable\n' })
  assert.match(apply(m).out, /rc=1$/)
  assert.equal(readFileSync(m.SOURCE, 'utf8'), SOURCE_TEXT('stable'))
})

test('a missing source or one without Suites answers 1', { skip: root }, () => {
  assert.match(apply(machine({ channel: 'experimental', source: null })).out, /rc=1$/)
  const m = machine({ channel: 'experimental', source: 'Types: deb\n' })
  assert.match(apply(m).out, /rc=1$/)
  assert.equal(readFileSync(m.SOURCE, 'utf8'), 'Types: deb\n')
})

test('a failed sed leaves the source untouched and answers 2', { skip: root }, () => {
  const m = machine({ channel: 'experimental\n' })
  const r = apply(m, 'sed() { return 1; }')
  assert.match(r.out, /rc=2$/)
  assert.match(r.err, /stays as it is/)
  assert.equal(readFileSync(m.SOURCE, 'utf8'), SOURCE_TEXT('stable'))
  assert.deepEqual(readdirSync(m.dir).sort(), ['channel', 'orbital.sources', 'user'])
})

test('a truncated write is never moved over the source', { skip: root }, () => {
  const m = machine({ channel: 'experimental\n' })
  // sed writes part of the file and dies, as on a full disk.
  const r = apply(m, `sed() { printf 'Types: deb\\n'; return 4; }`)
  assert.match(r.out, /rc=2$/)
  assert.equal(readFileSync(m.SOURCE, 'utf8'), SOURCE_TEXT('stable'))
})

test('a read-only directory leaves the source untouched and answers 2', { skip: root }, () => {
  const m = machine({ channel: 'experimental\n' })
  chmodSync(m.dir, 0o500)
  try {
    const r = apply(m)
    assert.match(r.out, /rc=2$/)
    assert.equal(readFileSync(m.SOURCE, 'utf8'), SOURCE_TEXT('stable'))
  } finally {
    chmodSync(m.dir, 0o700)
  }
})
