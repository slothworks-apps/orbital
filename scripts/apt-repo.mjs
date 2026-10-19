#!/usr/bin/env node
// The apt repository the `orbital` package ships through (spec
// 2026-10-19-headless-server-design → The apt repository): one suite
// (`stable`), one component (`main`), one architecture (`amd64`), every
// released version kept, the Release file signed with the repository's key.
// It lives in an S3 bucket (a MinIO) served at apt.slothworks.io.
//
//   node scripts/apt-repo.mjs add --deb <file> --packages <file|-> --out <dir>
//       The repository's new files in <dir>, to upload over the bucket:
//         pool/main/o/orbital/<the .deb>
//         dists/stable/main/binary-amd64/Packages, Packages.gz,
//           and by-hash/SHA256/<hash> copies of both
//         dists/stable/Release, Release.gpg, InRelease
//         orbital.gpg                      the public key, binary
//       --packages is the repository's current Packages file (`-` for none,
//       the first release); its entries are kept, so the pool on the bucket
//       is never downloaded or rewritten. A version it lists already is not
//       added again (mergePackages). The key is the armored secret key
//       in APT_GPG_PRIVATE_KEY, its passphrase (if any) in APT_GPG_PASSPHRASE.
//       Needs dpkg-scanpackages and gpg.
//
//       Writes added=true|false to $GITHUB_OUTPUT when it is set.
//
//   node scripts/apt-repo.mjs resign --packages <file> --out <dir>
//       The index for that Packages file signed again, nothing added: what
//       .github/workflows/apt-resign.yml runs so the Release never passes its
//       Valid-Until (APT_VALID_DAYS) between releases.
//
//   node scripts/apt-repo.mjs --check <version> [--base <URL> | --file <Packages>]
//       Whether the repository (apt.slothworks.io unless --base) lists
//       `orbital` <version>, a Debian version (debVersion), in a Packages file
//       its valid InRelease vouches for (`check`); with --file, whether that
//       Packages file lists it. Exit 0 listed, 1 not listed, 2 the repository
//       could not be asked.
//
// Upload pool/ first, then the by-hash copies and the Packages files, then the
// Release files, so a client never reads an index that names a file not there
// yet.
/* global AbortSignal, Buffer, console, process, fetch */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

export const APT_URL = 'https://apt.slothworks.io'
export const SUITE = 'stable'
export const COMPONENT = 'main'
export const ARCH = 'amd64'
export const PACKAGES_PATH = `dists/${SUITE}/${COMPONENT}/binary-${ARCH}/Packages`
export const PACKAGES_URL = `${APT_URL}/${PACKAGES_PATH}`
export const POOL = `pool/${COMPONENT}/o/orbital`

// A Packages file's entries: blank-line separated, `Field: value`, a line
// that starts with a space continues the field before it.
export function parsePackages(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((block) => block.replace(/^\n+|\n+$/g, ''))
    .filter((block) => block !== '')
    .map((raw) => {
      const fields = {}
      let last = null
      for (const line of raw.split('\n')) {
        if (/^[ \t]/.test(line)) {
          if (last) fields[last] += `\n${line}`
          continue
        }
        const colon = line.indexOf(':')
        if (colon <= 0) continue
        last = line.slice(0, colon).trim().toLowerCase()
        fields[last] = line.slice(colon + 1).trim()
      }
      return { raw, fields }
    })
}

export function listsVersion(text, version, pkg = 'orbital') {
  return parsePackages(text).some((e) => e.fields.package === pkg && e.fields.version === version)
}

// The current entries with the new one added. A version already listed is
// left as it is, the .deb clients may have fetched with it included: a run
// that repeats a release only signs the index again, which also mends a
// release whose upload stopped between the Packages and the Release files.
export function mergePackages(current, added) {
  const entry = parsePackages(added)
  if (entry.length !== 1) throw new Error(`expected one new Packages entry, got ${entry.length}`)
  const { package: pkg, version } = entry[0].fields
  const entries = parsePackages(current)
  const listed = entries.some((e) => e.fields.package === pkg && e.fields.version === version)
  const all = listed ? entries : [...entries, entry[0]]
  return { text: `${all.map((e) => e.raw).join('\n\n')}\n`, added: !listed, version }
}

// How long a signed Release stays valid. apt refuses an index past its
// Valid-Until, so a mirror or a man in the middle cannot keep serving an old
// index (and an old, vulnerable version) for ever. Every release signs the
// index again, and .github/workflows/apt-resign.yml does once a month without
// a release: 90 days outlast two missed monthly runs.
export const APT_VALID_DAYS = 90

// The Debian version of a desktop version: a semver prerelease (`-beta.1`)
// sorts after its release in Debian unless it is written with `~`.
export function debVersion(version) {
  return version.replaceAll('-', '~')
}

const rfc2822 = (date) => date.toUTCString().replace(/GMT$/, 'UTC')
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

// The suite's Release file over the index files, named relative to
// dists/<suite>/. SHA256 only, which every apt that reads by hash uses; with
// Acquire-By-Hash a client fetches each index by its hash, so an upload never
// shows it an index that does not match the Release it holds.
export function releaseFile(files, date, validDays = APT_VALID_DAYS) {
  const lines = [
    'Origin: Orbital',
    'Label: Orbital',
    `Suite: ${SUITE}`,
    `Codename: ${SUITE}`,
    `Date: ${rfc2822(date)}`,
    `Valid-Until: ${rfc2822(new Date(date.getTime() + validDays * 86_400_000))}`,
    `Architectures: ${ARCH}`,
    `Components: ${COMPONENT}`,
    'Acquire-By-Hash: yes',
    'Description: Orbital for Ubuntu',
    'SHA256:',
  ]
  for (const { name, data } of files) {
    lines.push(` ${sha256(data)} ${String(data.length).padStart(16)} ${name}`)
  }
  return `${lines.join('\n')}\n`
}


// What a Release or InRelease file says: each index's SHA256, and Valid-Until.
// The clear-signed wrapper of InRelease carries neither field, so it is read
// through.
export function parseRelease(text) {
  const hashes = new Map()
  let validUntil = null
  let inSha256 = false
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s/.test(line)) {
      if (!inSha256) continue
      const [hash, , name] = line.trim().split(/\s+/)
      if (hash && name) hashes.set(name, hash)
      continue
    }
    inSha256 = line === 'SHA256:'
    const valid = /^Valid-Until:\s*(.+)$/.exec(line)
    if (valid) validUntil = new Date(valid[1].replace(/UTC$/, 'GMT'))
  }
  return { sha256: hashes, validUntil }
}

function gpg(home, args, input) {
  return execFileSync('gpg', ['--homedir', home, '--batch', '--yes', ...args], {
    input,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
}

// Signs Release into InRelease and Release.gpg, and exports the public key.
function sign(dir, out) {
  const key = process.env.APT_GPG_PRIVATE_KEY
  if (!key) throw new Error('APT_GPG_PRIVATE_KEY is not set')
  const passphrase = process.env.APT_GPG_PASSPHRASE ?? ''
  const home = mkdtempSync(join(tmpdir(), 'orbital-gpg-'))
  try {
    gpg(home, ['--import'], key)
    const fpr = gpg(home, ['--list-secret-keys', '--with-colons'])
      .toString()
      .split('\n')
      .find((l) => l.startsWith('fpr:'))
      ?.split(':')[9]
    if (!fpr) throw new Error('APT_GPG_PRIVATE_KEY holds no secret key')
    const signing = [
      '--pinentry-mode',
      'loopback',
      '--passphrase-fd',
      '0',
      '--local-user',
      fpr,
      '--digest-algo',
      'SHA512',
    ]
    const release = join(dir, 'Release')
    gpg(home, [...signing, '--clearsign', '--output', join(dir, 'InRelease'), release], passphrase)
    gpg(home, [...signing, '--detach-sign', '--armor', '--output', join(dir, 'Release.gpg'), release], passphrase)
    writeFileSync(join(out, 'orbital.gpg'), gpg(home, ['--export', fpr]))
    // What apt does with the source's Signed-By: both signatures check against the published key.
    execFileSync('gpgv', ['--keyring', join(out, 'orbital.gpg'), join(dir, 'InRelease')], { stdio: 'ignore' })
    execFileSync('gpgv', ['--keyring', join(out, 'orbital.gpg'), join(dir, 'Release.gpg'), release], {
      stdio: 'ignore',
    })
    return fpr
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

export function addRelease({ deb, packages, out, now = new Date(), signed = true }) {
  // The new .deb's entry alone, scanned where it is the only file, with its
  // Filename relative to the repository's root.
  const scan = mkdtempSync(join(tmpdir(), 'orbital-scan-'))
  let entry
  try {
    mkdirSync(join(scan, POOL), { recursive: true })
    copyFileSync(deb, join(scan, POOL, basename(deb)))
    entry = execFileSync('dpkg-scanpackages', ['--multiversion', POOL, '/dev/null'], {
      cwd: scan,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString()
  } finally {
    rmSync(scan, { recursive: true, force: true })
  }
  const { text, added, version } = mergePackages(packages, entry)
  if (added) {
    mkdirSync(join(out, POOL), { recursive: true })
    copyFileSync(deb, join(out, POOL, basename(deb)))
  }

  return { packages: text, added, version, key: writeIndex({ text, out, now, signed }) }
}

// The index for `text` in out/dists: Packages, Packages.gz, their by-hash
// copies, the Release file and its signatures. Returns the signing key's
// fingerprint, or null unsigned.
export function writeIndex({ text, out, now = new Date(), signed = true }) {
  const suite = join(out, 'dists', SUITE)
  const index = `${COMPONENT}/binary-${ARCH}`
  const binary = join(suite, index)
  const byHash = join(binary, 'by-hash', 'SHA256')
  mkdirSync(byHash, { recursive: true })
  const plain = Buffer.from(text)
  const gz = gzipSync(plain, { level: 9 })
  for (const [name, data] of [['Packages', plain], ['Packages.gz', gz]]) {
    writeFileSync(join(binary, name), data)
    writeFileSync(join(byHash, sha256(data)), data)
  }
  writeFileSync(
    join(suite, 'Release'),
    releaseFile(
      [
        { name: `${index}/Packages`, data: plain },
        { name: `${index}/Packages.gz`, data: gz },
      ],
      now,
    ),
  )
  return signed ? sign(suite, out) : null
}

// Whether the repository lists `version` (a Debian version) as published:
// its Packages lists it, the SHA256 its InRelease gives for that Packages file
// matches, and the InRelease is still valid. An index caught half uploaded, or
// expired, is not shipped, so the release job runs and signs it again.
export async function check(version, { base = APT_URL, fetchFn = fetch, now = new Date() } = {}) {
  const get = async (path) => {
    const url = `${base}/${path}`
    const res = await fetchFn(url, { signal: AbortSignal.timeout(20_000) })
    // No index yet: the first release has not happened.
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`)
    return Buffer.from(await res.arrayBuffer())
  }
  const [packages, inRelease] = await Promise.all([get(PACKAGES_PATH), get(`dists/${SUITE}/InRelease`)])
  if (packages === null || inRelease === null) return false
  const release = parseRelease(inRelease.toString('utf8'))
  if (release.sha256.get(`${COMPONENT}/binary-${ARCH}/Packages`) !== sha256(packages)) return false
  if (release.validUntil !== null && !(release.validUntil > now)) return false
  return listsVersion(packages.toString('utf8'), version)
}

function flags(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument: ${argv[i]}`)
    out[argv[i].slice(2)] = argv[i + 1]
  }
  return out
}

async function main(argv) {
  if (argv[0] === '--check') {
    const f = flags(argv.slice(2))
    if (!argv[1]) throw new Error('usage: apt-repo.mjs --check <version> [--base <URL> | --file <Packages>]')
    let listed
    try {
      listed = f.file
        ? listsVersion(readFileSync(f.file, 'utf8'), argv[1])
        : await check(argv[1], f.base ? { base: f.base } : {})
    } catch (e) {
      console.error(`could not ask the repository: ${e.message}`)
      process.exit(2)
    }
    console.log(listed ? `orbital ${argv[1]} is listed` : `orbital ${argv[1]} is not listed`)
    process.exit(listed ? 0 : 1)
  }
  if (argv[0] === 'add') {
    const f = flags(argv.slice(1))
    if (!f.deb || !f.packages || !f.out) {
      throw new Error('usage: apt-repo.mjs add --deb <file> --packages <file|-> --out <dir>')
    }
    const packages = f.packages === '-' ? '' : readFileSync(f.packages, 'utf8')
    const { key, added, version } = addRelease({ deb: resolve(f.deb), packages, out: resolve(f.out) })
    if (!added) console.log(`orbital ${version} is listed already: its entry and .deb stay; the index is signed again.`)
    console.log(`Signed with ${key}; the repository's files are in ${f.out}`)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `added=${added}\n`)
    return
  }
  if (argv[0] === 'resign') {
    const f = flags(argv.slice(1))
    if (!f.packages || !f.out) throw new Error('usage: apt-repo.mjs resign --packages <file> --out <dir>')
    const text = readFileSync(f.packages, 'utf8')
    if (parsePackages(text).length === 0) throw new Error(`${f.packages} lists no package: nothing to sign`)
    const key = writeIndex({ text, out: resolve(f.out) })
    console.log(`Signed again with ${key}; the index is in ${f.out}`)
    return
  }
  throw new Error('usage: apt-repo.mjs add … | resign … | --check <version>')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
