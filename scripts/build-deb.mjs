#!/usr/bin/env node
// Builds the `orbital` package for Ubuntu on x64 (spec
// 2026-10-19-headless-server-design → The package): the server and the CLI
// as `npm run build -w server` left them, a pinned Node runtime, the runtime
// externals for linux-x64, the systemd units and the maintainer scripts from
// linux/. The version is the desktop's: it is the same server.
//
//   npm run build -w server && node scripts/build-deb.mjs [--out <dir>]
//
// Writes <dir>/orbital_<version>_amd64.deb (default linux/out) and prints
// its path. Needs `dpkg-deb` (Ubuntu's dpkg, or Homebrew's `dpkg` on a Mac)
// and `tar` with xz. The Node tarball is cached in linux/.cache and checked
// against NODE.sha256 on every build.
//
// Layout:
//   /usr/lib/orbital/node                      the runtime
//   /usr/lib/orbital/VERSION                   read by the server at start
//   /usr/lib/orbital/server/index.mjs          server/dist/index.mjs
//   /usr/lib/orbital/server/drizzle/           server/drizzle
//   /usr/lib/orbital/cli.mjs                   server/dist/cli.mjs
//   /usr/lib/orbital/update                    the root updater's script
//   /usr/lib/orbital/node_modules/             better-sqlite3, node-pty, the SDK
//   /usr/bin/orbital                           the CLI wrapper
//   /usr/lib/systemd/user/orbital.service
//   /usr/lib/systemd/system/orbital-update.{service,path}
//   /etc/apt/preferences.d/orbital.pref        the pin (a conffile)
/* global URL, Buffer, console, process, fetch */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { debVersion } from './apt-repo.mjs'
import { DESKTOP_PACKAGE, packageVersion } from './release-plan.mjs'

// The Node the desktop's Electron 44.5.1 embeds (process.versions.node), so
// the server runs on the same runtime on both. The hash is the official
// SHASUMS256.txt line for the tarball.
export const NODE = {
  version: '24.21.0',
  sha256: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
}

export const PACKAGE = 'orbital'
export const ARCH = 'amd64'
export const MAINTAINER = 'SlothWorks s.r.o. <orbital@slothworks.io>'
export const LIB = 'usr/lib/orbital'

export function nodeTarball(version = NODE.version) {
  return `node-v${version}-linux-x64.tar.xz`
}

export function debName(version) {
  return `${PACKAGE}_${debVersion(version)}_${ARCH}.deb`
}

// glibc 2.35 is Ubuntu 22.04's, where the package is built and the oldest
// release it supports; the Node runtime and the prebuilt addons need less.
// The runtime and the addons are C++ and link libstdc++ and libgcc_s.
// `version` is the desktop's; the control file writes it as Debian sorts it.
export function controlFile({ version, installedSize }) {
  return [
    `Package: ${PACKAGE}`,
    `Version: ${debVersion(version)}`,
    `Architecture: ${ARCH}`,
    `Maintainer: ${MAINTAINER}`,
    `Installed-Size: ${installedSize}`,
    'Depends: libc6 (>= 2.35), libstdc++6, libgcc-s1, ca-certificates',
    'Recommends: git',
    'Section: devel',
    'Priority: optional',
    'Homepage: https://orbital.slothworks.io',
    'Description: Orbital server for a Linux machine in an Orbital group',
    ' Runs Claude Code sessions on this machine for the other devices of an',
    ' Orbital group (a Mac, a phone) to see and drive, as a systemd user',
    ' service. Includes the orbital command line. Run orbital setup once,',
    ' as the user Orbital should run as.',
    '',
  ].join('\n')
}

// What of each runtime external ships: its JS, its licence, and the one
// linux-x64 prebuild. Paths are relative to the package's directory.
export const EXTERNALS = {
  'better-sqlite3': (p) =>
    p === 'package.json' ||
    p === 'LICENSE' ||
    p === 'lib' ||
    p.startsWith(`lib${sep}`) ||
    p === 'prebuilds' ||
    p === join('prebuilds', 'linux-x64.node'),
  // On Linux node-pty forks through the addon itself; `spawn-helper` exists
  // only in the macOS prebuilds.
  'node-pty': (p) =>
    p === 'package.json' ||
    p === 'LICENSE' ||
    ((p === 'lib' || p.startsWith(`lib${sep}`)) && !p.endsWith('.map')) ||
    p === 'prebuilds' ||
    p === join('prebuilds', 'linux-x64') ||
    p.startsWith(join('prebuilds', 'linux-x64') + sep),
  // The SDK without any claude-agent-sdk-<platform>-<arch> package: those
  // are separate packages, never copied, and `claude` is found on PATH.
  '@anthropic-ai/claude-agent-sdk': () => true,
}

// A platform package of the SDK anywhere under `dir`; the package must carry none.
export function findSdkPlatformPackages(dir) {
  const found = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(d, entry.name)
      if (/^claude-agent-sdk-/.test(entry.name)) found.push(path)
      else walk(path)
    }
  }
  walk(dir)
  return found
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

// The tarball, from the cache or nodejs.org, checked against the pin.
async function nodeRuntime(cacheDir) {
  const name = nodeTarball()
  const file = join(cacheDir, name)
  if (!existsSync(file)) {
    mkdirSync(cacheDir, { recursive: true })
    const url = `https://nodejs.org/dist/v${NODE.version}/${name}`
    console.error(`Downloading ${url}`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`)
    writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()))
    execFileSync('mv', [`${file}.part`, file])
  }
  const actual = sha256(file)
  if (actual !== NODE.sha256) {
    rmSync(file)
    throw new Error(`${name}: SHA-256 ${actual}, expected ${NODE.sha256}; removed it`)
  }
  return file
}

function locate(root, name) {
  for (const base of [join(root, 'server', 'node_modules'), join(root, 'node_modules')]) {
    const dir = join(base, name)
    if (existsSync(join(dir, 'package.json'))) return dir
  }
  throw new Error(`${name} is not installed: run npm ci first`)
}

function copyFiltered(src, dest, keep) {
  cpSync(src, dest, {
    recursive: true,
    filter: (path) => {
      const rel = relative(src, path)
      return rel === '' || keep(rel)
    },
  })
}

function walkFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(path))
    else out.push(path)
  }
  return out
}

// Every directory 0755, every file 0644 but the ones that run.
function normaliseModes(dir, executables) {
  chmodSync(dir, 0o755)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) normaliseModes(path, executables)
    else chmodSync(path, executables.has(path) ? 0o755 : 0o644)
  }
}

function sizeKiB(dir) {
  return Math.ceil(walkFiles(dir).reduce((sum, f) => sum + statSync(f).size, 0) / 1024)
}

export async function buildDeb({ root, outDir }) {
  const read = (path) => readFileSync(join(root, path), 'utf8')
  const version = packageVersion(read(DESKTOP_PACKAGE), DESKTOP_PACKAGE)
  const built = {
    server: join(root, 'server', 'dist', 'index.mjs'),
    cli: join(root, 'server', 'dist', 'cli.mjs'),
    drizzle: join(root, 'server', 'drizzle'),
  }
  for (const path of Object.values(built)) {
    if (!existsSync(path)) throw new Error(`${path} is missing: run npm run build -w server first`)
  }
  const linux = join(root, 'linux')
  const tarball = await nodeRuntime(join(linux, '.cache'))

  const work = mkdtempSync(join(tmpdir(), 'orbital-deb-'))
  try {
    const stage = join(work, 'root')
    const lib = join(stage, LIB)
    mkdirSync(join(lib, 'server'), { recursive: true })

    const unpacked = join(work, 'node')
    mkdirSync(unpacked)
    const top = `node-v${NODE.version}-linux-x64`
    execFileSync('tar', ['-xJf', tarball, '-C', unpacked, `${top}/bin/node`, `${top}/LICENSE`])
    copyFileSync(join(unpacked, top, 'bin', 'node'), join(lib, 'node'))

    writeFileSync(join(lib, 'VERSION'), `${version}\n`)
    copyFileSync(built.server, join(lib, 'server', 'index.mjs'))
    cpSync(built.drizzle, join(lib, 'server', 'drizzle'), { recursive: true })
    copyFileSync(built.cli, join(lib, 'cli.mjs'))
    copyFileSync(join(linux, 'update'), join(lib, 'update'))
    for (const [name, keep] of Object.entries(EXTERNALS)) {
      copyFiltered(locate(root, name), join(lib, 'node_modules', name), keep)
    }
    const platformPackages = findSdkPlatformPackages(stage)
    if (platformPackages.length > 0) {
      throw new Error(`the package must carry no SDK platform package: ${platformPackages.join(', ')}`)
    }

    const place = (from, to) => {
      mkdirSync(dirname(join(stage, to)), { recursive: true })
      copyFileSync(join(linux, from), join(stage, to))
    }
    place('orbital', 'usr/bin/orbital')
    place('orbital.service', 'usr/lib/systemd/user/orbital.service')
    place('orbital-update.service', 'usr/lib/systemd/system/orbital-update.service')
    place('orbital-update.path', 'usr/lib/systemd/system/orbital-update.path')
    place('orbital.pref', 'etc/apt/preferences.d/orbital.pref')
    const doc = join(stage, 'usr/share/doc/orbital')
    mkdirSync(doc, { recursive: true })
    copyFileSync(join(root, 'LICENSE'), join(doc, 'copyright'))
    copyFileSync(join(unpacked, top, 'LICENSE'), join(doc, 'node-LICENSE'))

    const executables = new Set([
      join(lib, 'node'),
      join(lib, 'update'),
      join(stage, 'usr/bin/orbital'),
    ])
    normaliseModes(stage, executables)

    // md5sums lists every file but the conffiles, as dpkg's own tools do.
    const installedSize = sizeKiB(stage)
    const md5sums = walkFiles(stage)
      .map((f) => relative(stage, f).split(sep).join('/'))
      .filter((rel) => !rel.startsWith('etc/'))
      .sort()
      .map((rel) => `${createHash('md5').update(readFileSync(join(stage, rel))).digest('hex')}  ${rel}`)
      .join('\n')

    const debian = join(stage, 'DEBIAN')
    mkdirSync(debian)
    writeFileSync(join(debian, 'control'), controlFile({ version, installedSize }))
    writeFileSync(join(debian, 'conffiles'), '/etc/apt/preferences.d/orbital.pref\n')
    writeFileSync(join(debian, 'md5sums'), `${md5sums}\n`)
    for (const script of ['postinst', 'prerm', 'postrm']) {
      copyFileSync(join(linux, 'debian', script), join(debian, script))
    }
    normaliseModes(
      debian,
      new Set(['postinst', 'prerm', 'postrm'].map((s) => join(debian, s))),
    )

    mkdirSync(outDir, { recursive: true })
    const out = join(outDir, debName(version))
    execFileSync('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', stage, out], {
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    return out
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function main(argv) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  let outDir = join(root, 'linux', 'out')
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) outDir = resolve(argv[++i])
    else throw new Error(`usage: build-deb.mjs [--out <dir>] (not ${argv[i]})`)
  }
  console.log(await buildDeb({ root, outDir }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
