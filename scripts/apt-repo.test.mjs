/* global Buffer, Response */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { check, listsVersion, mergePackages, parsePackages, releaseFile } from './apt-repo.mjs'

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

test('the Release file lists each index with its size and hashes', () => {
  const data = Buffer.from('Package: orbital\n')
  const text = releaseFile([{ name: 'main/binary-amd64/Packages', data }], new Date(Date.UTC(2026, 9, 19, 8, 0, 0)))
  assert.match(text, /^Date: Mon, 19 Oct 2026 08:00:00 UTC$/m)
  assert.match(text, /^Suite: stable$/m)
  assert.match(text, /^Architectures: amd64$/m)
  const sha256 = createHash('sha256').update(data).digest('hex')
  assert.match(text, new RegExp(`^SHA256:\\n ${sha256} +${data.length} main/binary-amd64/Packages$`, 'm'))
})

test('--check: listed, not listed, no index yet, and a failure', async () => {
  const answer = (status, body = '') => async () => new Response(body, { status })
  assert.equal(await check('0.34.0', 'u', answer(200, `${entry('0.34.0')}\n`)), true)
  assert.equal(await check('0.35.0', 'u', answer(200, `${entry('0.34.0')}\n`)), false)
  assert.equal(await check('0.34.0', 'u', answer(404)), false)
  await assert.rejects(check('0.34.0', 'u', answer(503)), /503/)
})
