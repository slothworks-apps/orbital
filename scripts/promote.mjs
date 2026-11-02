#!/usr/bin/env node
// Moves what the experimental channel has to stable, on every platform at
// once, without building or signing anything (spec
// 2026-11-02-experimental-release-channel-design → Promote, ADR
// a-release-reaches-experimental-before-stable). Run by
// .github/workflows/promote.yml, which supplies the tokens and does the apt
// upload; every decision is here.
//
//   node scripts/promote.mjs plan --out <file>
//       Reads, changes nothing: the newest published GitHub Release and
//       whether it is a prerelease, the apt suites through apt.slothworks.io,
//       and the versions Beam's experimental and production channels serve.
//       Writes the plan as JSON to <file>, and its outputs to $GITHUB_OUTPUT.
//       Stops when the experimental suite does not list the desktop's
//       version: the release has not finished. On a stop, the reason goes to
//       $GITHUB_STEP_SUMMARY.
//   node scripts/promote.mjs beam --plan <file>
//       Promotes the plan's phone version to Beam's production channel.
//   node scripts/promote.mjs summary --plan <file>
//       The job summary: each platform from which version to which, or
//       already stable. Each step's outcome comes in DESKTOP_OUTCOME,
//       APT_OUTCOME and PHONE_OUTCOME (a step's `outcome` in the workflow).
//
// Each move is planned only when it is not done yet, so a re-run after a
// failure finishes the job: the plan reads again and skips what is stable.
//
// Everything above the CLI is pure or takes its lookups as arguments, so
// scripts/promote.test.mjs runs without gh, apt.slothworks.io or Beam.
/* global URL, console, process, fetch */
import { execFile } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  EXPERIMENTAL,
  STABLE,
  debVersion,
  listsVersion,
  parsePackages,
  publishedPackages,
} from './apt-repo.mjs'
import {
  BEAM_CONFIG,
  RELEASE_CHANNEL,
  STABLE_CHANNEL,
  channelVersion,
  promoteBundle,
  readBeam,
} from './beam.mjs'

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** Semver order, prerelease identifiers included; null for what is not a version. */
export function parseVersion(version) {
  const m = SEMVER.exec(version ?? '')
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) throw new Error(`cannot compare "${a}" with "${b}"`)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i]
  // A version without a prerelease part sorts after one with it.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/**
 * The desktop's releases, as `gh release list --json
 * tagName,isDraft,isPrerelease,isLatest` gives them: the newest published
 * one by version (a draft is a release whose upload did not finish), and the
 * one GitHub calls Latest — what stable Macs have.
 */
export function desktopReleases(releases) {
  const published = releases
    .filter((r) => !r.isDraft && /^v/.test(r.tagName) && parseVersion(r.tagName.slice(1)))
    .map((r) => ({ ...r, version: r.tagName.slice(1) }))
  if (published.length === 0)
    throw new Error('GitHub has no published release v<version>: nothing to promote')
  const newest = published.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a))
  const latest = published.find((r) => r.isLatest) ?? null
  return { newest, latest }
}

/** The last `orbital` version a Packages file lists, or null. */
export function lastListed(text) {
  const versions = parsePackages(text ?? '')
    .filter((e) => e.fields.package === 'orbital')
    .map((e) => e.fields.version)
  return versions.at(-1) ?? null
}

/**
 * What Promote does. `releases` is gh's list; `apt` the two suites'
 * Packages files as published (null: none, or not vouched for); `beam` the
 * version each channel serves (null: none). Throws when the experimental
 * suite does not list the desktop's version.
 *
 * Each platform's `action`:
 *   promote   the move is still to do
 *   stable    already done
 *   none      the phone: Beam's experimental channel serves nothing
 *   behind    the phone: experimental serves a lower version than production
 */
export function decide({ releases, apt, beam }) {
  const { newest, latest } = desktopReleases(releases)
  const desktop = {
    version: newest.version,
    from: latest?.version ?? null,
    // A release that is not a prerelease but not Latest either was half
    // promoted by hand: setting it Latest finishes that.
    action: newest.isPrerelease || !newest.isLatest ? 'promote' : 'stable',
  }

  const deb = debVersion(newest.version)
  if (apt.experimental === null || !listsVersion(apt.experimental, deb)) {
    throw new Error(
      `the apt suite ${EXPERIMENTAL} does not list orbital ${deb}: the release of ${newest.tagName} ` +
        'has not finished. Run Release again (Actions → Release → Run workflow), then Promote.',
    )
  }
  const aptPlan = {
    version: deb,
    from: lastListed(apt.stable),
    action: apt.stable !== null && listsVersion(apt.stable, deb) ? 'stable' : 'promote',
  }

  const to = beam.experimental
  const from = beam.production
  let action
  if (to === null) action = 'none'
  else if (from === to) action = 'stable'
  else if (from !== null && compareVersions(to, from) < 0) action = 'behind'
  else action = 'promote'
  const phone = { version: to, from, action }

  return { desktop, apt: aptPlan, phone }
}

export function outputs(plan) {
  return [
    `desktop=${plan.desktop.action}`,
    `desktop-version=${plan.desktop.version}`,
    `apt=${plan.apt.action}`,
    `apt-version=${plan.apt.version}`,
    `phone=${plan.phone.action}`,
    `phone-version=${plan.phone.version ?? ''}`,
  ].join('\n')
}

const LABELS = { desktop: 'Mac (GitHub Release)', apt: 'Linux (apt)', phone: 'Phone (Beam)' }

/**
 * One row per platform. `outcomes` holds each move step's outcome
 * (success, failure, cancelled, skipped); a move the plan did not need is
 * reported from the plan.
 */
export function summary(plan, outcomes = {}) {
  const row = (key) => {
    const p = plan[key]
    const from = p.from ?? '—'
    const to = p.version ?? '—'
    let result
    if (p.action === 'stable') result = `already stable (${to})`
    else if (p.action === 'none') result = 'nothing in experimental'
    else if (p.action === 'behind') result = `production is ahead (${from}); nothing moved`
    else {
      const outcome = outcomes[key]
      if (outcome === 'success') result = `promoted ${from} → ${to}`
      else if (outcome === 'failure') result = `failed: ${from} → ${to} not done; run Promote again`
      else result = `not done (${outcome || 'not run'}): ${from} → ${to}; run Promote again`
    }
    return `| ${LABELS[key]} | ${from} | ${to} | ${result} |`
  }
  return [
    '## Promote',
    '',
    '| Platform | Stable was | Experimental | Result |',
    '|---|---|---|---|',
    row('desktop'),
    row('apt'),
    row('phone'),
    '',
  ].join('\n')
}

// The real lookups, over `gh`, apt.slothworks.io and Beam. `gh` and `fetch`
// are passed in, so the tests run them against stubs.
export function makeLookups({ gh, fetch, beam, uploadKey, aptBase }) {
  const base = aptBase ? { base: aptBase } : {}
  return {
    async releases() {
      const out = await gh([
        'release',
        'list',
        '--limit',
        '100',
        '--json',
        'tagName,isDraft,isPrerelease,isLatest',
      ])
      return JSON.parse(out)
    },
    apt: (suite) => publishedPackages({ suite, fetchFn: fetch, ...base }),
    channel: (name) => channelVersion({ beam, uploadKey, name, fetch }),
  }
}

/** All reads first, nothing changed; then the plan. */
export async function readPlan(lookups) {
  const [releases, experimental, stable, beamExperimental, production] = await Promise.all([
    lookups.releases(),
    lookups.apt(EXPERIMENTAL),
    lookups.apt(STABLE),
    lookups.channel(RELEASE_CHANNEL),
    lookups.channel(STABLE_CHANNEL),
  ])
  return decide({
    releases,
    apt: { experimental, stable },
    beam: { experimental: beamExperimental, production },
  })
}

/** Beam's move: the plan's phone version to production, unless the plan says it is done. */
export async function promotePhone(plan, { beam, uploadKey, fetch }) {
  if (plan.phone.action !== 'promote') return 'skipped'
  return promoteBundle({
    beam,
    uploadKey,
    name: STABLE_CHANNEL,
    version: plan.phone.version,
    fetch,
  })
}

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error)
        reject(new Error(`gh ${args.join(' ')} failed: ${(stderr || error.message).trim()}`))
      else resolve(stdout)
    })
  })
}

function flag(argv, name) {
  const at = argv.indexOf(name)
  const value = at === -1 ? undefined : argv[at + 1]
  if (!value) throw new Error(`${argv[0]} needs ${name} <file>`)
  return value
}

function writeSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
}

function beamConfig() {
  return readBeam(readFileSync(new URL(`../${BEAM_CONFIG}`, import.meta.url), 'utf8'))
}

async function main(argv) {
  if (argv[0] === 'plan') {
    const out = flag(argv, '--out')
    let plan
    try {
      plan = await readPlan(
        makeLookups({ gh, fetch, beam: beamConfig(), uploadKey: process.env.BEAM_UPLOAD_KEY }),
      )
    } catch (e) {
      writeSummary(`## Promote\n\nNothing moved: ${e.message}`)
      throw e
    }
    writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`)
    console.log(outputs(plan))
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${outputs(plan)}\n`)
    return
  }
  if (argv[0] === 'beam') {
    const plan = JSON.parse(readFileSync(flag(argv, '--plan'), 'utf8'))
    const status = await promotePhone(plan, {
      beam: beamConfig(),
      uploadKey: process.env.BEAM_UPLOAD_KEY,
      fetch,
    })
    console.log(`Beam: ${plan.phone.version} to ${STABLE_CHANNEL}: ${status}`)
    return
  }
  if (argv[0] === 'summary') {
    const plan = JSON.parse(readFileSync(flag(argv, '--plan'), 'utf8'))
    const text = summary(plan, {
      desktop: process.env.DESKTOP_OUTCOME,
      apt: process.env.APT_OUTCOME,
      phone: process.env.PHONE_OUTCOME,
    })
    console.log(text)
    writeSummary(text)
    return
  }
  throw new Error(
    'usage: promote.mjs plan --out <file> | beam --plan <file> | summary --plan <file>',
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
