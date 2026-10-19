#!/usr/bin/env node
// The apt repository the `orbital` package ships through (spec
// 2026-10-19-headless-server-design → The apt repository): one suite
// (`stable`), one component (`main`), one architecture (`amd64`), every
// released version kept, the Release file signed with the repository's key.
// It lives in an R2 bucket served at apt.slothworks.io.
//
//   node scripts/apt-repo.mjs add --deb <file> --packages <file|-> --out <dir>
//       The repository's new files in <dir>, to upload over the bucket:
//         pool/main/o/orbital/<the .deb>
//         dists/stable/main/binary-amd64/Packages, Packages.gz
//         dists/stable/Release, Release.gpg, InRelease
//         orbital.gpg                      the public key, binary
//       --packages is the repository's current Packages file (`-` for none,
//       the first release); its entries are kept, so the pool on the bucket
//       is never downloaded or rewritten. A version it lists already is not
//       added again (mergePackages). The key is the armored secret key
//       in APT_GPG_PRIVATE_KEY, its passphrase (if any) in APT_GPG_PASSPHRASE.
//       Needs dpkg-scanpackages and gpg.
//
//   node scripts/apt-repo.mjs --check <version> [--url <Packages URL>]
//       Whether the repository lists `orbital` <version>: exit 0 listed,
//       1 not listed, 2 the repository could not be asked.
//
// Upload pool/ first, then the Packages files, then the Release files, so a
// client never reads an index that names a file not there yet.
/* global AbortSignal, Buffer, console, process, fetch */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const DIGESTS = [
  ['MD5Sum', 'md5'],
  ['SHA1', 'sha1'],
  ['SHA256', 'sha256'],
  ['SHA512', 'sha512'],
]

// The suite's Release file over the index files, named relative to dists/<suite>/.
export function releaseFile(files, date) {
  const lines = [
    'Origin: Orbital',
    'Label: Orbital',
    `Suite: ${SUITE}`,
    `Codename: ${SUITE}`,
    `Date: ${date.toUTCString().replace(/GMT$/, 'UTC')}`,
    `Architectures: ${ARCH}`,
    `Components: ${COMPONENT}`,
    'Description: Orbital for Ubuntu',
  ]
  for (const [field, algorithm] of DIGESTS) {
    lines.push(`${field}:`)
    for (const { name, data } of files) {
      const hash = createHash(algorithm).update(data).digest('hex')
      lines.push(` ${hash} ${String(data.length).padStart(16)} ${name}`)
    }
  }
  return `${lines.join('\n')}\n`
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

  const suite = join(out, 'dists', SUITE)
  const binary = join(suite, COMPONENT, `binary-${ARCH}`)
  mkdirSync(binary, { recursive: true })
  const plain = Buffer.from(text)
  const gz = gzipSync(plain, { level: 9 })
  writeFileSync(join(binary, 'Packages'), plain)
  writeFileSync(join(binary, 'Packages.gz'), gz)
  const index = `${COMPONENT}/binary-${ARCH}`
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
  return { packages: text, added, version, key: signed ? sign(suite, out) : null }
}

export async function check(version, url = PACKAGES_URL, fetchFn = fetch) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(20_000) })
  // No index yet: the first release has not happened.
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`)
  return listsVersion(await res.text(), version)
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
    const { url } = flags(argv.slice(2))
    if (!argv[1]) throw new Error('usage: apt-repo.mjs --check <version> [--url <Packages URL>]')
    let listed
    try {
      listed = await check(argv[1], url)
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
    return
  }
  throw new Error('usage: apt-repo.mjs add … | --check <version>')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
