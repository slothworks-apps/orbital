import { useState } from 'react'
import type { ApiSession, OrbitalModel, SessionStatus, Subagent, Tag } from '../lib/types'
import { useOrbital } from '../store/store'
import { SpaceMap } from '../map/SpaceMap'
import { ErrorBoundary } from '../ui/ErrorBoundary'

/**
 * `/sandbox/cluster` — the real space map over a fixed, server-free set of
 * sessions: two tags of mixed tiers, a planet with moons, parked planets
 * wearing DONE and NEEDS INPUT pills, and one planet selected.
 *
 * It exists to look at spacing — whether labels, pills and reticles in an
 * ordinary cluster keep clear of each other once the simulation settles —
 * without waiting for real sessions to arrange themselves that way. Like
 * `/sandbox`, it is mounted instead of `<App>` (see `main.tsx`), so it opens
 * no WebSocket; it seeds the store directly and renders `<SpaceMap>` alone.
 * The map fits itself on load exactly as the app does.
 */

const MODELS: OrbitalModel[] = [
  {
    value: 'opus[1m]',
    resolvedModel: 'claude-opus-5[1m]',
    family: 'Opus',
    version: 'Opus 5 with 1M context',
    shortVersion: 'Opus 5',
    variant: '1M',
    blurb: '',
    contextWindow: 1_000_000,
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    family: 'Sonnet',
    version: 'Sonnet 5',
    shortVersion: 'Sonnet 5',
    variant: null,
    blurb: '',
    contextWindow: 200_000,
  },
]

const TAGS: Tag[] = [
  { id: 1, name: 'orbital', hue: 210, is_default: 0 },
  { id: 2, name: 'infra', hue: 30, is_default: 0 },
]

function fixtureSession(
  id: string,
  tag: number,
  status: SessionStatus,
  title: string,
  options: { asks?: boolean; moons?: number; sonnet?: boolean } = {}
): ApiSession {
  const now = Date.now()
  const subagents: Subagent[] = Array.from({ length: options.moons ?? 0 }, (_, i) => ({
    id: `${id}-agent-${i}`,
    name: `agent ${i + 1}`,
    state: 'working',
    startedAt: now,
  }))
  return {
    id,
    cwd: '/sandbox',
    title,
    firstAt: now - 3_600_000,
    lastAt: now,
    messageCount: 12,
    source: 'web',
    permissionMode: null,
    model: options.sonnet ? 'sonnet' : 'opus[1m]',
    resolvedModel: options.sonnet ? 'claude-sonnet-5' : 'claude-opus-5[1m]',
    parentId: null,
    mapDismissedAt: null,
    tagIds: [tag],
    status,
    subagents,
    awaitingSubagents: subagents.length > 0,
    ...(options.asks
      ? { pendingDecision: { kind: 'permission' } as unknown as ApiSession['pendingDecision'] }
      : {}),
  }
}

const SESSIONS: ApiSession[] = [
  // The cluster from the bug report: a selected planet and two DONE ones.
  fixtureSession('infra-1', 2, 'working', 'Migrate the release pipeline'),
  fixtureSession('infra-2', 2, 'needs_input', 'Rotate the signing certificates'),
  fixtureSession('infra-3', 2, 'needs_input', 'Audit the nightly backup job', { sonnet: true }),
  // A larger one: moons, an asking planet, idle and ended tiers.
  fixtureSession('orb-1', 1, 'working', 'Spacing of labels on the map', { moons: 2 }),
  fixtureSession('orb-2', 1, 'needs_input', 'Detached session windows', { asks: true }),
  fixtureSession('orb-3', 1, 'idle', 'Walkthrough page polish', { sonnet: true }),
  fixtureSession('orb-4', 1, 'ended', 'Stats drilldown for one session'),
  fixtureSession('orb-5', 1, 'ended', 'Fix login'),
]

function seedStore() {
  const sessions: Record<string, ApiSession> = {}
  for (const session of SESSIONS) sessions[session.id] = session
  useOrbital.setState((state) => ({
    sessions,
    order: SESSIONS.map((s) => s.id),
    tags: TAGS,
    models: MODELS,
    sessionsTotal: SESSIONS.length,
    // Ended planets stay on the map, released never: the spacing is what is
    // being looked at, not the release.
    settings: { ...state.settings, map_release_ended_after_minutes: 'never' },
    ui: { ...state.ui, selectedId: 'infra-1', sidebarCollapsed: true, urlRestored: true },
  }))
}

export function ClusterSandboxPage() {
  // Seeded once, before the map's first render reads the store.
  useState(seedStore)
  return (
    <div className="relative h-screen w-screen overflow-hidden bg-space">
      <div className="absolute inset-0">
        <ErrorBoundary label="Space map">
          <SpaceMap />
        </ErrorBoundary>
      </div>
    </div>
  )
}
