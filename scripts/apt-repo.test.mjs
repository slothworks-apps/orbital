/* global Buffer, Response */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  APT_VALID_DAYS,
  check,
  debVersion,
  listsVersion,
  mergePackages,
  parsePackages,
  parseRelease,
  releaseFile,
} from './apt-repo.mjs'

const entry = (version, pkg = 'orbital') =>
  [
    `Package: ${pkg}`,
    `Version: ${version}`,
    'Architecture: amd64',
    `Filename: pool/main/o/${pkg}/${pkg}_${version}_amd64.deb`,
    'Description: Orbital server',
    ' Runs Claude Code sessions.',
    ' .',
    ' Version: 9.9.9 in a description is not a version.',
  ].join('\n')

test('reads entries, their continuation lines, and CRLF', () => {
  const text = `${entry('0.34.0')}\n\n${entry('0.35.0')}\r\n\r\n${entry('1.0.0', 'other')}\n`
  const all = parsePackages(text)
  assert.equal(all.length, 3)
  assert.equal(all[0].fields.version, '0.34.0')
  assert.match(all[0].fields.description, /\n Runs Claude Code sessions\./)
  assert.equal(all[2].fields.package, 'other')
})

test('a version is listed only for the orbital package, exactly', () => {
  const text = `${entry('0.34.0')}\n\n${entry('1.0.0', 'other')}\n`
  assert.equal(listsVersion(text, '0.34.0'), true)
  assert.equal(listsVersion(text, '0.34'), false)
  assert.equal(listsVersion(text, '1.0.0'), false)
  assert.equal(listsVersion(text, '9.9.9'), false)
  assert.equal(listsVersion('', '0.34.0'), false)
})

test('a new version is added after the ones kept', () => {
  const merged = mergePackages(`${entry('0.33.0')}\n\n${entry('0.34.0')}\n`, `${entry('0.35.0')}\n`)
  assert.equal(merged.added, true)
  assert.deepEqual(
    parsePackages(merged.text).map((e) => e.fields.version),
    ['0.33.0', '0.34.0', '0.35.0'],
  )
  assert.equal(mergePackages('', `${entry('0.35.0')}\n`).text, `${entry('0.35.0')}\n`)
})

test('a version listed already stays as it was', () => {
  const current = `${entry('0.34.0')}\n`
  const rebuilt = entry('0.34.0').replace('amd64.deb', 'amd64.deb\nSHA256: other')
  const merged = mergePackages(current, rebuilt)
  assert.equal(merged.added, false)
  assert.equal(merged.text, current)
})

test('the new entry must be one entry', () => {
  assert.throws(() => mergePackages('', ''), /one new Packages entry, got 0/)
  assert.throws(() => mergePackages('', `${entry('1')}\n\n${entry('2')}`), /got 2/)
})

test('the Release file lists each index by SHA256, by hash, valid for APT_VALID_DAYS', () => {
  const data = Buffer.from('Package: orbital\n')
  const text = releaseFile([{ name: 'main/binary-amd64/Packages', data }], new Date(Date.UTC(2026, 9, 19, 8, 0, 0)))
  assert.match(text, /^Date: Mon, 19 Oct 2026 08:00:00 UTC$/m)
  assert.equal(APT_VALID_DAYS, 90)
  assert.match(text, /^Valid-Until: Sun, 17 Jan 2027 08:00:00 UTC$/m)
  assert.match(text, /^Acquire-By-Hash: yes$/m)
  assert.match(text, /^Suite: stable$/m)
  assert.doesNotMatch(text, /^(MD5Sum|SHA1|SHA512):/m)
  const hash = createHash('sha256').update(data).digest('hex')
  assert.match(text, new RegExp(`^SHA256:\\n ${hash} +${data.length} main/binary-amd64/Packages$`, 'm'))
  // What --check reads back from it.
  const read = parseRelease(text)
  assert.equal(read.sha256.get('main/binary-amd64/Packages'), hash)
  assert.equal(read.validUntil.toISOString(), '2027-01-17T08:00:00.000Z')
})

test('a prerelease is written with ~ in the Debian version', () => {
  assert.equal(debVersion('0.35.0'), '0.35.0')
  assert.equal(debVersion('0.35.0-beta.1'), '0.35.0~beta.1')
  assert.equal(debVersion('1.0.0-rc.1-2'), '1.0.0~rc.1-2')
})

// A repository at `base` answering Packages and an InRelease over `vouched`.
function repo({ packages, vouched = packages, validUntil, now = new Date(Date.UTC(2026, 9, 19)) }) {
  const data = Buffer.from(vouched ?? '')
  let release = releaseFile([{ name: 'main/binary-amd64/Packages', data }], now)
  if (validUntil) release = release.replace(/^Valid-Until: .*$/m, `Valid-Until: ${validUntil}`)
  const signed = `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\n${release}-----BEGIN PGP SIGNATURE-----\n\nabc\n-----END PGP SIGNATURE-----\n`
  return async (url) => {
    if (url.endsWith('/binary-amd64/Packages')) {
      return packages === null ? new Response('', { status: 404 }) : new Response(packages)
    }
    if (url.endsWith('/InRelease')) return vouched === null ? new Response('', { status: 404 }) : new Response(signed)
    return new Response('', { status: 404 })
  }
}

test('--check: listed only in a Packages file the valid InRelease vouches for', async () => {
  const now = new Date(Date.UTC(2026, 9, 20))
  const listed = `${entry('0.34.0')}\n`
  assert.equal(await check('0.34.0', { fetchFn: repo({ packages: listed }), now }), true)
  assert.equal(await check('0.35.0', { fetchFn: repo({ packages: listed }), now }), false)
  // Packages uploaded, InRelease not yet: the index does not match.
  assert.equal(await check('0.34.0', { fetchFn: repo({ packages: listed, vouched: '' }), now }), false)
  // Past its Valid-Until.
  const expired = repo({ packages: listed, validUntil: 'Thu, 01 Oct 2026 00:00:00 UTC' })
  assert.equal(await check('0.34.0', { fetchFn: expired, now }), false)
  // No repository yet.
  assert.equal(await check('0.34.0', { fetchFn: repo({ packages: null, vouched: null }), now }), false)
  await assert.rejects(check('0.34.0', { fetchFn: async () => new Response('', { status: 503 }), now }), /503/)
})
