/* global Buffer, Response */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { releaseFile } from './apt-repo.mjs'
import { readBeam } from './beam.mjs'
import {
  compareVersions,
  decide,
  desktopReleases,
  lastListed,
  makeLookups,
  outputs,
  promotePhone,
  readPlan,
  summary,
} from './promote.mjs'

const release = (version, { draft = false, pre = false, latest = false } = {}) => ({
  tagName: `v${version}`,
  isDraft: draft,
  isPrerelease: pre,
  isLatest: latest,
})

const entry = (version) =>
  [
    'Package: orbital',
    `Version: ${version}`,
    'Architecture: amd64',
    `Filename: pool/main/o/orbital/orbital_${version}_amd64.deb`,
  ].join('\n')
const packages = (...versions) => `${versions.map(entry).join('\n\n')}\n`

// 0.45.1 is stable everywhere; 0.46.0 has been released to experimental.
const released = {
  releases: [
    release('0.46.0', { pre: true }),
    release('0.45.1', { latest: true }),
    release('0.45.0'),
    release('0.47.0', { draft: true, pre: true }),
  ],
  apt: { experimental: packages('0.46.0'), stable: packages('0.45.0', '0.45.1') },
  beam: { experimental: '0.23.0', production: '0.22.1' },
}

test('versions sort by semver, a prerelease before its release', () => {
  const sorted = [
    '0.10.0',
    '0.9.1',
    '0.46.0-beta.2',
    '0.46.0',
    '0.46.0-beta.10',
    '0.46.0-alpha',
    '1.0.0',
  ]
  sorted.sort(compareVersions)
  assert.deepEqual(sorted, [
    '0.9.1',
    '0.10.0',
    '0.46.0-alpha',
    '0.46.0-beta.2',
    '0.46.0-beta.10',
    '0.46.0',
    '1.0.0',
  ])
  assert.throws(() => compareVersions('mobile-ios-v1', '1.0.0'), /cannot compare/)
})

test("the desktop's newest release is the highest published version, not a draft or another tag", () => {
  const { newest, latest } = desktopReleases([
    ...released.releases,
    { tagName: 'mobile-ios-v9.0.0', isDraft: false, isPrerelease: false, isLatest: false },
    release('0.100.0-rc.1', { draft: true }),
  ])
  assert.equal(newest.version, '0.46.0')
  assert.equal(latest.version, '0.45.1')
  assert.throws(() => desktopReleases([release('0.46.0', { draft: true })]), /no published release/)
})

test('a fresh release moves on all three platforms', () => {
  const plan = decide(released)
  assert.deepEqual(plan, {
    desktop: { version: '0.46.0', from: '0.45.1', action: 'promote' },
    apt: { version: '0.46.0', from: '0.45.1', action: 'promote' },
    phone: { version: '0.23.0', from: '0.22.1', action: 'promote' },
  })
  assert.equal(
    outputs(plan),
    'desktop=promote\ndesktop-version=0.46.0\napt=promote\napt-version=0.46.0\nphone=promote\nphone-version=0.23.0',
  )
})

test('a re-run skips what is stable already and finishes the rest', () => {
  // The apt step and the GitHub edit went through, Beam failed.
  const plan = decide({
    releases: [release('0.46.0', { latest: true }), release('0.45.1')],
    apt: { experimental: packages('0.46.0'), stable: packages('0.45.1', '0.46.0') },
    beam: { experimental: '0.23.0', production: '0.22.1' },
  })
  assert.equal(plan.desktop.action, 'stable')
  assert.equal(plan.apt.action, 'stable')
  assert.equal(plan.phone.action, 'promote')
})

test('a release taken out of prerelease by hand but not made Latest is finished', () => {
  const plan = decide({
    ...released,
    releases: [release('0.46.0'), release('0.45.1', { latest: true })],
  })
  assert.equal(plan.desktop.action, 'promote')
})

test('stops when the experimental suite does not list the version: the release has not finished', () => {
  for (const experimental of [packages('0.45.1'), '', null]) {
    assert.throws(
      () => decide({ ...released, apt: { experimental, stable: packages('0.45.1') } }),
      /does not list orbital 0\.46\.0: the release of v0\.46\.0 has not finished\. Run Release again/,
    )
  }
})

test('an empty or missing stable suite is promoted into', () => {
  for (const stable of ['', null]) {
    const plan = decide({ ...released, apt: { experimental: packages('0.46.0'), stable } })
    assert.deepEqual(plan.apt, { version: '0.46.0', from: null, action: 'promote' })
  }
})

test('a desktop prerelease version is looked up as its Debian version', () => {
  const plan = decide({
    ...released,
    releases: [release('0.46.0-beta.1', { pre: true }), release('0.45.1', { latest: true })],
    apt: { experimental: packages('0.46.0~beta.1'), stable: packages('0.45.1') },
  })
  assert.equal(plan.apt.version, '0.46.0~beta.1')
})

test('the phone: nothing in experimental, already production, or production ahead', () => {
  const phone = (experimental, production) =>
    decide({ ...released, beam: { experimental, production } }).phone.action
  assert.equal(phone(null, '0.22.1'), 'none')
  assert.equal(phone('0.22.1', '0.22.1'), 'stable')
  assert.equal(phone('0.22.0', '0.22.1'), 'behind')
  assert.equal(phone('0.23.0', null), 'promote')
})

test('lastListed is the last orbital entry', () => {
  assert.equal(lastListed(packages('0.45.0', '0.45.1')), '0.45.1')
  assert.equal(lastListed(''), null)
  assert.equal(lastListed(null), null)
})

test('the summary says from → to, already stable, or what is left', () => {
  const plan = decide({
    ...released,
    apt: { experimental: packages('0.46.0'), stable: packages('0.45.1', '0.46.0') },
  })
  const text = summary(plan, { desktop: 'success', phone: 'failure' })
  assert.match(
    text,
    /\| Mac \(GitHub Release\) \| 0\.45\.1 \| 0\.46\.0 \| promoted 0\.45\.1 → 0\.46\.0 \|/,
  )
  assert.match(text, /\| Linux \(apt\) \| 0\.46\.0 \| 0\.46\.0 \| already stable \(0\.46\.0\) \|/)
  assert.match(text, /\| Phone \(Beam\) \| 0\.22\.1 \| 0\.23\.0 \| failed: .* run Promote again \|/)
  assert.match(summary(plan, {}), /Mac .* not done \(not run\)/)
  const none = decide({ ...released, beam: { experimental: null, production: '0.22.1' } })
  assert.match(summary(none, {}), /Phone \(Beam\) \| 0\.22\.1 \| — \| nothing in experimental/)
})

// The real lookups against stubs of gh, apt.slothworks.io and Beam.
const beam = readBeam('{"url":"https://beam.example","appId":"io.example.app"}')

function aptIndex(text, suite) {
  const release = releaseFile(
    [{ name: 'main/binary-amd64/Packages', data: Buffer.from(text) }],
    new Date(),
    {
      suite,
    },
  )
  return { packages: text, inRelease: `-----BEGIN PGP SIGNED MESSAGE-----\n\n${release}` }
}

function stubs({
  releases,
  apt,
  channels,
  promote = { status: 200, body: { status: 'promoted' } },
}) {
  const calls = []
  const ghCalls = []
  const fetch = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      key: init.headers?.['X-Upload-Key'],
      body: init.body,
    })
    const aptMatch =
      /^https:\/\/apt\.example\/dists\/(\w+)\/(main\/binary-amd64\/Packages|InRelease)$/.exec(url)
    if (aptMatch) {
      const index = apt[aptMatch[1]]
      if (!index) return new Response('', { status: 404 })
      return new Response(aptMatch[2] === 'InRelease' ? index.inRelease : index.packages)
    }
    const channel =
      /^https:\/\/beam\.example\/api\/apps\/io\.example\.app\/channels\/(\w+)(\/promote)?$/.exec(
        url,
      )
    if (channel && channel[2]) return Response.json(promote.body, { status: promote.status })
    if (channel && channel[1] in channels)
      return Response.json({ name: channel[1], version: channels[channel[1]] })
    if (channel) return Response.json({ error: 'channel_not_found' }, { status: 404 })
    throw new Error(`unexpected fetch ${url}`)
  }
  const gh = async (args) => {
    ghCalls.push(args)
    return JSON.stringify(releases)
  }
  return {
    calls,
    ghCalls,
    fetch,
    lookups: makeLookups({ gh, fetch, beam, uploadKey: 'k', aptBase: 'https://apt.example' }),
  }
}

test('reads gh, both apt suites and both Beam channels, and changes nothing', async () => {
  const s = stubs({
    releases: released.releases,
    apt: {
      experimental: aptIndex(packages('0.46.0'), 'experimental'),
      stable: aptIndex(packages('0.45.1'), 'stable'),
    },
    channels: { experimental: '0.23.0', production: '0.22.1' },
  })
  const plan = await readPlan(s.lookups)
  assert.deepEqual(
    plan,
    decide({ ...released, apt: { experimental: packages('0.46.0'), stable: packages('0.45.1') } }),
  )
  assert.deepEqual(s.ghCalls, [
    ['release', 'list', '--limit', '100', '--json', 'tagName,isDraft,isPrerelease,isLatest'],
  ])
  assert.ok(s.calls.every((c) => c.method === 'GET'))
  assert.ok(
    s.calls.filter((c) => c.url.startsWith('https://beam.example')).every((c) => c.key === 'k'),
  )
})

test('an experimental index that does not match its InRelease stops the plan', async () => {
  const torn = aptIndex(packages('0.46.0'), 'experimental')
  torn.packages = packages('0.45.1', '0.46.0')
  const s = stubs({
    releases: released.releases,
    apt: { experimental: torn, stable: aptIndex(packages('0.45.1'), 'stable') },
    channels: { experimental: '0.23.0', production: '0.22.1' },
  })
  await assert.rejects(readPlan(s.lookups), /does not list orbital 0\.46\.0/)
})

test('a Beam without the experimental channel stops the plan', async () => {
  const s = stubs({
    releases: released.releases,
    apt: { experimental: aptIndex(packages('0.46.0'), 'experimental') },
    channels: { production: '0.22.1' },
  })
  await assert.rejects(readPlan(s.lookups), /no channel "experimental"/)
})

test('promotes the phone by version to production, or skips it when the plan says so', async () => {
  const s = stubs({
    releases: [],
    apt: {},
    channels: {},
    promote: { status: 200, body: { status: 'unchanged' } },
  })
  const plan = decide(released)
  assert.equal(await promotePhone(plan, { beam, uploadKey: 'k', fetch: s.fetch }), 'unchanged')
  assert.equal(
    s.calls[0].url,
    'https://beam.example/api/apps/io.example.app/channels/production/promote',
  )
  assert.equal(s.calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(s.calls[0].body), { version: '0.23.0' })

  const done = { ...plan, phone: { ...plan.phone, action: 'stable' } }
  assert.equal(await promotePhone(done, { beam, uploadKey: 'k', fetch: s.fetch }), 'skipped')
  assert.equal(s.calls.length, 1)

  const refused = stubs({
    releases: [],
    apt: {},
    channels: {},
    promote: { status: 404, body: { error: 'version_not_found' } },
  })
  await assert.rejects(
    promotePhone(plan, { beam, uploadKey: 'k', fetch: refused.fetch }),
    /refused to promote 0\.23\.0 to production \(404\)/,
  )
})
