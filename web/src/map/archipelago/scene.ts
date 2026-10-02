import type { ScenePlanet, SceneModel } from '../sceneModel'
import type { CameraState } from '../camera'
import { bodyZoomFactor } from '../camera'
import { sessionStateKey, statePill, type SessionStateKey, type Subagent } from '../../lib/types'
import { stateColor } from '../../lib/stateStyle'
import { truncateLabel } from '../visuals'
import { decisionHeadline } from '../../lib/decisionCard'
import {
  SHIP_LENGTH,
  angleDiff,
  berthFor,
  berthGroup,
  coastPolygon,
  coastRadius,
  harbourAngle,
  islandRadius,
  islandReach,
  islandSeed,
  pier,
  polar,
  routeStep,
  safeRadius,
  shorePoint,
  spreadFactor,
  type Island,
  type Point,
} from './geometry'

/**
 * The Archipelago theme's drawing (spec 2026-10-01-map-themes-design § 3).
 *
 * Imperative on purpose: ships sail every frame, and pushing that through
 * React would re-render the tree sixty times a second. `ArchipelagoMap` owns
 * the React side — model, selection, camera, input — and hands this class
 * the latest of each; this class owns the SVG and the label layer and only
 * ever touches the DOM it created.
 *
 * World space is the planet map's: y up, `camera.zoom` px per unit. The SVG's
 * world group flips y once; labels are HTML placed in screen px.
 */

const NS = 'http://www.w3.org/2000/svg'
/** The prototype drew a 66-unit hull; this scales its path data to `SHIP_LENGTH`. */
const HULL_UNITS = 66
const SHIP_SPEED = 0.6
const BOAT_SPEED = 0.45
const LEAVE_FADE_SEC = 0.5
const CONTEXT_COLOURS = { ok: '#7fe3b0', warn: '#ffbb7b', critical: '#fa8880' } as const

export interface SceneInput {
  model: SceneModel
  /** `subagentPanel` as `sessionId:subagentId`, for the open boat's ring. */
  activeBoatKey: string | null
  detachedIds: string[]
  statePills: 'dot' | 'label'
  showCompactBadge: boolean
  reduced: boolean
}

export type DropState = 'none' | 'eligible' | 'armed' | 'refused'

interface IslandView {
  island: Island
  anchor: Point
  g: SVGGElement
  plaque: HTMLDivElement
  lights: { dot: SVGCircleElement; halo: SVGCircleElement; phase: number }[]
  flag: SVGPathElement
  flagAt: Point
  key: string
  working: number
}

interface ShipView {
  id: string
  planet: ScenePlanet
  g: SVGGElement
  body: SVGGElement
  hull: SVGPathElement
  sails: { path: SVGPathElement; len: number }[]
  pennant: SVGPathElement
  halo: SVGCircleElement
  wins: SVGRectElement[]
  ring: SVGPathElement
  compactRings: SVGCircleElement[]
  select: SVGGElement
  shadow: SVGPathElement
  wake: SVGPathElement[]
  label: HTMLDivElement
  labelKey: string
  x: number
  y: number
  vx: number
  vy: number
  h: number
  k: number
  phase: number
  bob: number
  trail: { x: number; y: number; h: number; t: number }[]
  lastTrail: number
  prevKey: SessionStateKey | null
  leaveAt: number | null
}

interface BoatView {
  key: string
  sessionId: string
  subagent: Subagent
  g: SVGGElement
  body: SVGGElement
  oars: SVGPathElement
  lantern: SVGCircleElement
  ring: SVGCircleElement
  tether: SVGLineElement
  shadow: SVGPathElement
  label: HTMLDivElement
  x: number
  y: number
  vx: number
  vy: number
  h: number
  opacity: number
  mode: 'out' | 'scout' | 'back'
  target: Point
  until: number
  phase: number
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag)
  for (const k in attrs) e.setAttribute(k, String(attrs[k]))
  if (parent) parent.appendChild(e)
  return e
}

const ease = (dt: number, k: number) => 1 - Math.exp(-dt * k)
const hsl = (hue: number, s: number, l: number, a = 1) => `hsl(${hue} ${s}% ${l}% / ${a})`
const fmt = (n: number) => n.toFixed(3)

/** Seeded generator for an island's trees and houses, so its outline and village never change. */
function rng(seed: number) {
  let s = Math.floor(seed * 100000) % 2147483647 || 1
  return () => (s = (s * 16807) % 2147483647) / 2147483647
}

const HULL = 'M-30 -10 Q-36 0 -30 10 L16 11 Q40 0 16 -11 Z'
const DECK = 'M-26 -7 Q-30 0 -26 7 L14 8 Q32 0 14 -8 Z'
const BOAT = 'M-10 -4.5 Q-13 0 -10 4.5 L5 5 Q14 0 5 -5 Z'

function pathOf(points: Point[]): string {
  return points.map((p, i) => `${i ? 'L' : 'M'}${fmt(p.x)} ${fmt(p.y)}`).join('') + 'Z'
}

/** Whether a session draws on the pier's flagpole, and in what tone. */
function flagFor(key: SessionStateKey): string | null {
  if (key === 'idle' || key === 'ended') return null
  return stateColor(key)
}

export class ArchipelagoScene {
  readonly svg: SVGSVGElement
  private world: SVGGElement
  private wavePattern: SVGPatternElement
  private layers: Record<'shallow' | 'islands' | 'wake' | 'shadow' | 'boats' | 'ships' | 'ui', SVGGElement>
  private labelLayer: HTMLDivElement
  private islands = new Map<number, IslandView>()
  private ships = new Map<string, ShipView>()
  private boats = new Map<string, BoatView>()
  private input: SceneInput | null = null
  private spread = 1
  private hole: { g: SVGGElement; beam: SVGPathElement; glow: SVGCircleElement; label: HTMLDivElement; at: Point; visible: boolean }
  private dragged: { kind: 'island'; tagId: number; at: Point } | { kind: 'ship'; id: string; at: Point } | null = null
  private drop: DropState = 'none'
  private t = 0

  constructor(host: HTMLElement) {
    this.svg = el('svg', { class: 'absolute inset-0 h-full w-full', 'data-archipelago': '' })
    host.appendChild(this.svg)
    this.labelLayer = document.createElement('div')
    this.labelLayer.className = 'pointer-events-none absolute inset-0 overflow-hidden'
    host.appendChild(this.labelLayer)

    const defs = el('defs', {}, this.svg)
    defs.innerHTML = `
      <radialGradient id="arch-lantern"><stop offset="0" stop-color="#ffbb7b" stop-opacity=".7"/><stop offset=".45" stop-color="#ffbb7b" stop-opacity=".18"/><stop offset="1" stop-color="#ffbb7b" stop-opacity="0"/></radialGradient>
      <radialGradient id="arch-warm"><stop offset="0" stop-color="#f0d39a" stop-opacity=".5"/><stop offset="1" stop-color="#f0d39a" stop-opacity="0"/></radialGradient>
      <filter id="arch-soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation=".22"/></filter>`
    this.wavePattern = el('pattern', { id: 'arch-waves', patternUnits: 'userSpaceOnUse', width: 2.6, height: 1.7 }, defs)
    el('path', {
      d: 'M.2 .4 q.15 -.1 .3 0 M1.35 1 q.15 -.1 .3 0 M2.05 1.5 q.12 -.07 .24 0 M.7 1.4 q.12 -.07 .24 0 M1.8 .3 q.1 -.07 .2 0',
      stroke: '#1d3a58',
      'stroke-width': 0.026,
      fill: 'none',
      'stroke-linecap': 'round',
    }, this.wavePattern)

    this.world = el('g', {}, this.svg)
    el('rect', { x: -5000, y: -5000, width: 10000, height: 10000, fill: 'url(#arch-waves)', opacity: 0.9 }, this.world)
    this.layers = {
      shallow: el('g', {}, this.world),
      islands: el('g', {}, this.world),
      wake: el('g', { fill: 'none', 'stroke-linecap': 'round' }, this.world),
      shadow: el('g', {}, this.world),
      boats: el('g', {}, this.world),
      ships: el('g', {}, this.world),
      ui: el('g', {}, this.world),
    }

    const hg = el('g', { 'data-hole': '', class: 'cursor-pointer' }, this.layers.islands)
    const glow = el('circle', { r: 1.6, fill: 'url(#arch-warm)', opacity: 0.6 }, hg)
    el('path', { d: shipPath(rockPoints()), fill: '#1c2430' }, hg)
    el('path', { d: 'M-.18 .1 L-.12 1.05 L.12 1.05 L.18 .1 Z', fill: '#c9cfd8' }, hg)
    el('path', { d: 'M-.15 .45 L.15 .45 L.14 .58 L-.14 .58 Z', fill: '#8b3a3a' }, hg)
    el('circle', { cx: 0, cy: 1.12, r: 0.1, fill: '#f0d39a' }, hg)
    const beam = el('path', { d: '', fill: '#f0d39a', opacity: 0.08 }, hg)
    const label = document.createElement('div')
    label.className = 'pointer-events-auto absolute left-0 top-0 cursor-pointer whitespace-nowrap rounded-lg border border-[rgba(150,205,255,.12)] bg-[rgba(8,13,22,.82)] px-2.5 py-1.5 font-mono text-[10px] tracking-[0.12em] text-text-muted'
    label.dataset.hole = ''
    this.labelLayer.appendChild(label)
    this.hole = { g: hg, beam, glow, label, at: { x: 0, y: 0 }, visible: true }
  }

  destroy(): void {
    this.svg.remove()
    this.labelLayer.remove()
  }

  /** World factor the archipelago spreads the planet map's anchors by. */
  get spreadFactor(): number {
    return this.spread
  }

  setInput(input: SceneInput): void {
    this.input = input
    this.syncIslands()
    this.syncShips()
    this.syncHole()
  }

  /** Overrides an island's or a ship's position while it is dragged; null lets go. */
  setDragged(d: typeof this.dragged): void {
    this.dragged = d
  }

  setDrop(state: DropState): void {
    this.drop = state
  }

  holeAt(): Point | null {
    return this.hole.visible ? this.hole.at : null
  }

  /** Island centre for a tag, in world units (drag offsets read it). */
  islandAt(tagId: number): Point | null {
    const v = this.islands.get(tagId)
    return v ? { x: v.island.x, y: v.island.y } : null
  }

  shipAt(id: string): Point | null {
    const v = this.ships.get(id)
    return v ? { x: v.x, y: v.y } : null
  }

  /** What fit frames: every island at its full reach, and the lighthouse. */
  fitBodies(): { x: number; y: number; r: number }[] {
    const out = [...this.islands.values()].map((v) => ({ x: v.island.x, y: v.island.y, r: islandReach(v.island, v.working) }))
    if (this.hole.visible) out.push({ x: this.hole.at.x, y: this.hole.at.y, r: 1.6 })
    return out
  }

  // ---------------------------------------------------------------- islands

  private syncIslands(): void {
    const model = this.input!.model
    const counts = new Map<number, { n: number; working: number; hue: number }>()
    for (const p of model.planets) {
      const c = counts.get(p.tagId) ?? { n: 0, working: 0, hue: p.hue }
      c.n++
      if (sessionStateKey(p.session) === 'working') c.working++
      counts.set(p.tagId, c)
    }
    const anchors = model.anchors.filter((a) => counts.has(a.tagId))
    const probes = anchors.map((a) => {
      const c = counts.get(a.tagId)!
      const isl: Island = { tagId: a.tagId, x: 0, y: 0, radius: islandRadius(c.n), seed: islandSeed(a.tagId), harbour: 0 }
      return islandReach(isl, Math.max(1, c.working))
    })
    this.spread = spreadFactor(anchors, probes)
    const centres = anchors.map((a) => ({ x: a.x * this.spread, y: a.y * this.spread }))
    const mid = centres.length
      ? { x: centres.reduce((s, c) => s + c.x, 0) / centres.length, y: centres.reduce((s, c) => s + c.y, 0) / centres.length }
      : { x: 0, y: 0 }

    const seen = new Set<number>()
    anchors.forEach((a, i) => {
      seen.add(a.tagId)
      const c = counts.get(a.tagId)!
      const centre = centres[i]
      const island: Island = {
        tagId: a.tagId,
        x: centre.x,
        y: centre.y,
        radius: islandRadius(c.n),
        seed: islandSeed(a.tagId),
        harbour: harbourAngle(centre, mid),
      }
      const label = model.labels.find((l) => l.tagId === a.tagId)
      const key = [island.x, island.y, island.radius, island.harbour, a.hue].map((n) => n.toFixed(3)).join('|')
      let view = this.islands.get(a.tagId)
      if (!view || view.key !== key) {
        view?.g.remove()
        view?.plaque.remove()
        view = this.drawIsland(island, a.hue, key)
        this.islands.set(a.tagId, view)
      }
      view.anchor = a
      view.working = c.working
      const plaqueText = label?.text ?? ''
      if (view.plaque.dataset.text !== plaqueText) {
        view.plaque.dataset.text = plaqueText
        view.plaque.querySelector('[data-name]')!.textContent = plaqueText
      }
    })
    for (const [tagId, v] of this.islands) {
      if (seen.has(tagId)) continue
      v.g.remove()
      v.plaque.remove()
      this.islands.delete(tagId)
    }
  }

  private drawIsland(island: Island, hue: number, key: string): IslandView {
    const g = el('g', { 'data-island': island.tagId, class: 'cursor-pointer' }, this.layers.islands)
    const R = island.radius
    el('path', { d: pathOf(coastPolygon(island, 1.45)), fill: '#0f2740', opacity: 0.7, filter: 'url(#arch-soft)' }, g)
    el('path', { d: pathOf(coastPolygon(island, 1.2)), fill: '#15344e', opacity: 0.75, filter: 'url(#arch-soft)' }, g)
    el('path', { d: pathOf(coastPolygon(island, 1.07)), fill: 'none', stroke: '#7ba6cc', 'stroke-width': 0.03, opacity: 0.2, 'stroke-dasharray': '.4 .55', 'data-surf': '' }, g)
    el('path', { d: pathOf(coastPolygon(island, 1)), fill: '#3a3326' }, g)
    el('path', { d: pathOf(coastPolygon(island, 0.9)), fill: '#1b2f22' }, g)
    el('path', { d: pathOf(coastPolygon({ ...island, seed: island.seed + 1.7 }, 0.5)), fill: '#213829' }, g)
    el('path', { d: pathOf(coastPolygon({ ...island, seed: island.seed + 3.1 }, 0.26)), fill: '#294231' }, g)

    const rand = rng(island.seed)
    const trees = Math.round(18 + R * 9)
    for (let i = 0; i < trees; i++) {
      const th = rand() * Math.PI * 2
      const rr = (0.12 + rand() * 0.7) * coastRadius(island, th)
      if (Math.abs(angleDiff(th, island.harbour)) < 0.75 && rr > R * 0.3) continue
      const p = polar(island, th, rr)
      const r = R * (0.03 + rand() * 0.032)
      el('circle', { cx: fmt(p.x + r * 0.3), cy: fmt(p.y - r * 0.4), r: fmt(r), fill: '#050c08', opacity: 0.45 }, g)
      el('circle', { cx: fmt(p.x), cy: fmt(p.y), r: fmt(r), fill: '#15281b' }, g)
      el('circle', { cx: fmt(p.x - r * 0.3), cy: fmt(p.y + r * 0.3), r: fmt(r * 0.5), fill: '#1f3c29' }, g)
    }
    const roof = hsl(hue, 45, 55, 0.6)
    const lights: IslandView['lights'] = []
    for (let i = 0; i < 8; i++) {
      const th = island.harbour + (rand() - 0.5) * 1.1
      const p = polar(island, th, (0.42 + rand() * 0.36) * coastRadius(island, th))
      const rot = (th * 180) / Math.PI + (rand() - 0.5) * 30
      const hg = el('g', { transform: `translate(${fmt(p.x)} ${fmt(p.y)}) rotate(${rot.toFixed(1)}) scale(${fmt(R / 185)})` }, g)
      el('rect', { x: -7, y: -5, width: 16, height: 12, fill: '#050c08', opacity: 0.4, transform: 'translate(2 -3)' }, hg)
      el('rect', { x: -8, y: -6, width: 16, height: 12, rx: 1.5, fill: roof }, hg)
      el('line', { x1: -8, x2: 8, y1: 0, y2: 0, stroke: '#0c1219', 'stroke-width': 1.2, opacity: 0.5 }, hg)
      const lp = polar(p, th + Math.PI / 2, R * 0.06)
      const halo = el('circle', { cx: fmt(lp.x), cy: fmt(lp.y), r: fmt(R * 0.05), fill: 'url(#arch-warm)' }, g)
      const dot = el('circle', { cx: fmt(lp.x), cy: fmt(lp.y), r: fmt(R * 0.009), fill: '#f0d39a' }, g)
      lights.push({ dot, halo, phase: rand() * Math.PI * 2 })
    }
    const kp = polar(island, island.harbour, coastRadius(island, island.harbour) * 0.8)
    const kg = el('g', { transform: `translate(${fmt(kp.x)} ${fmt(kp.y)}) rotate(${((island.harbour * 180) / Math.PI).toFixed(1)}) scale(${fmt(R / 185)})` }, g)
    el('rect', { x: -15, y: -19, width: 30, height: 38, rx: 2, fill: hsl(hue, 45, 55, 0.75) }, kg)
    el('line', { x1: 0, x2: 0, y1: -19, y2: 19, stroke: '#0c1219', 'stroke-width': 1.4, opacity: 0.45 }, kg)
    const flagAt = polar(island, island.harbour + 0.35, coastRadius(island, island.harbour) * 0.78)
    const flag = el('path', { fill: hsl(hue, 55, 60) }, g)
    el('circle', { cx: fmt(flagAt.x), cy: fmt(flagAt.y), r: fmt(R * 0.011), fill: '#c9cfd8' }, g)

    const p = pier(island)
    const n = { x: -p.dir.y, y: p.dir.x }
    const q = (a: number, b: number) => `${fmt(p.from.x + p.dir.x * a + n.x * b)} ${fmt(p.from.y + p.dir.y * a + n.y * b)}`
    const w = 0.13
    el('path', { d: `M${q(-0.1, -w)} L${q(p.length, -w)} L${q(p.length, w)} L${q(-0.1, w)} Z`, fill: '#5a4733' }, g)
    let planks = ''
    for (let a = 0; a < p.length; a += 0.11) planks += `M${q(a, -w)} L${q(a, w)} `
    el('path', { d: planks, stroke: '#3e3124', 'stroke-width': 0.018 }, g)
    const lamp = polar(p.from, island.harbour, p.length + 0.04)
    el('circle', { cx: fmt(lamp.x), cy: fmt(lamp.y), r: 0.5, fill: 'url(#arch-warm)' }, g)
    el('circle', { cx: fmt(lamp.x), cy: fmt(lamp.y), r: 0.045, fill: '#f0d39a' }, g)

    const plaque = document.createElement('div')
    plaque.className = 'pointer-events-auto absolute left-0 top-0 flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg border border-[rgba(255,255,255,.08)] bg-[rgba(10,16,26,.8)] px-2.5 py-1.5'
    plaque.dataset.island = String(island.tagId)
    plaque.innerHTML = `<i style="width:3px;height:18px;border-radius:2px;background:${hsl(hue, 60, 65)}"></i><span data-name class="font-mono text-[11px] font-semibold tracking-[0.16em] text-text-bright"></span>`
    this.labelLayer.appendChild(plaque)
    return { island, anchor: { x: 0, y: 0 }, g, plaque, lights, flag, flagAt, key, working: 0 }
  }

  // ---------------------------------------------------------------- ships

  private syncShips(): void {
    const model = this.input!.model
    const seen = new Set<string>()
    for (const p of model.planets) {
      seen.add(p.session.id)
      let v = this.ships.get(p.session.id)
      if (!v) {
        v = this.makeShip(p)
        this.ships.set(p.session.id, v)
      }
      v.planet = p
      if (p.leaving && v.leaveAt === null) v.leaveAt = this.t
      if (!p.leaving) v.leaveAt = null
      this.syncShipLabel(v)
    }
    for (const [id, v] of this.ships) {
      if (seen.has(id)) continue
      v.g.remove()
      v.shadow.remove()
      v.label.remove()
      v.wake.forEach((w) => w.remove())
      this.ships.delete(id)
    }
    // boats
    const live = new Set<string>()
    for (const p of model.planets) {
      for (const s of p.subagents) {
        const key = `${p.session.id}:${s.id}`
        live.add(key)
        const b = this.boats.get(key)
        if (b) b.subagent = s
        else if (s.state !== 'ended') this.boats.set(key, this.makeBoat(p.session.id, s))
      }
    }
    for (const [key, b] of this.boats) if (!live.has(key)) b.mode = 'back'
  }

  private makeShip(p: ScenePlanet): ShipView {
    const id = p.session.id
    const shadow = el('path', { d: HULL, fill: '#02060c', opacity: 0.5 }, this.layers.shadow)
    const g = el('g', { 'data-ship': id, class: 'cursor-pointer' }, this.layers.ships)
    const select = el('g', { opacity: 0 }, g)
    el('circle', { r: 46, fill: 'none', stroke: '#dfe6f0', 'stroke-width': 1.4, 'stroke-dasharray': '6 9', opacity: 0.6 }, select)
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      el('path', { d: `M${sx * 52} ${sy * 40} L${sx * 52} ${sy * 52} L${sx * 40} ${sy * 52}`, fill: 'none', stroke: '#dfe6f0', 'stroke-width': 1.6, opacity: 0.7 }, select)
    }
    const ring = el('path', { fill: 'none', 'stroke-width': 2.4, 'stroke-linecap': 'round' }, g)
    const compactRings = [0, 1].map(() => el('circle', { r: 40, fill: 'none', stroke: '#bee1ff', 'stroke-width': 1.2, opacity: 0 }, g))
    const body = el('g', {}, g)
    const halo = el('circle', { cx: -30, cy: 0, r: 54, fill: 'url(#arch-lantern)', opacity: 0 }, body)
    const hull = el('path', { d: HULL, fill: '#5b4936', 'stroke-width': 2.2 }, body)
    el('path', { d: DECK, fill: '#7a6449' }, body)
    el('path', { d: 'M-22 -2.6 H24 M-22 2.6 H24', stroke: '#67533c', 'stroke-width': 1 }, body)
    el('rect', { x: -27, y: -5.5, width: 10, height: 11, rx: 2, fill: '#463628' }, body)
    const wins = [-3, 2].map((y) => el('rect', { x: -20, y: y - 1.2, width: 2.4, height: 2.4, fill: '#ffbb7b', opacity: 0 }, body))
    const sails = [
      { x: 9, len: 13 },
      { x: -7, len: 16 },
    ].map((o) => {
      const sg = el('g', { transform: `translate(${o.x} 0)` }, body)
      el('line', { x1: 0, x2: 0, y1: -o.len * 1.05, y2: o.len * 1.05, stroke: '#3b2f22', 'stroke-width': 1.6 }, sg)
      const path = el('path', { fill: '#ebe5d4' }, sg)
      el('circle', { r: 1.9, fill: '#3b2f22' }, sg)
      return { path, len: o.len }
    })
    const pennant = el('path', {}, body)
    el('circle', { cx: -31, cy: 0, r: 2.1, fill: '#ffbb7b' }, body)

    const label = document.createElement('div')
    label.className = 'absolute left-0 top-0'
    label.dataset.shipLabel = id
    this.labelLayer.appendChild(label)

    const start = this.berthPoint(p)
    return {
      id,
      planet: p,
      g,
      body,
      hull,
      sails,
      pennant,
      halo,
      wins,
      ring,
      compactRings,
      select,
      shadow,
      wake: Array.from({ length: 16 }, () => el('path', { stroke: '#cfe0f2', 'stroke-width': 0.02, opacity: 0 }, this.layers.wake)),
      label,
      labelKey: '',
      x: start.x,
      y: start.y,
      vx: 0,
      vy: 0,
      h: start.h,
      k: sessionStateKey(p.session) === 'working' ? 1 : 0,
      phase: start.phase,
      bob: (id.charCodeAt(id.length - 1) % 17) / 3,
      trail: [],
      lastTrail: 0,
      prevKey: null,
      leaveAt: null,
    }
  }

  /** Where a ship first appears: at its berth, already settled — load never sails anyone in. */
  private berthPoint(p: ScenePlanet): Point & { h: number; phase: number } {
    const isl = this.islands.get(p.tagId)?.island
    if (!isl) return { x: p.x, y: p.y, h: 0, phase: 0 }
    const b = this.berthOf(p, isl)
    if (b.kind === 'orbit') {
      const phase = isl.harbour + 0.6 + this.groupIndex(p) * 2.1
      const at = polar(isl, phase, b.radius)
      return { ...at, h: phase + (b.direction * Math.PI) / 2, phase }
    }
    return { ...b.at, h: b.heading, phase: 0 }
  }

  private groupIndex(p: ScenePlanet): number {
    const group = berthGroup(sessionStateKey(p.session))
    return this.input!.model.planets
      .filter((q) => q.tagId === p.tagId && !q.leaving && berthGroup(sessionStateKey(q.session)) === group)
      .map((q) => q.session.id)
      .sort()
      .indexOf(p.session.id)
  }

  private berthOf(p: ScenePlanet, isl: Island) {
    return berthFor(isl, berthGroup(sessionStateKey(p.session)), Math.max(0, this.groupIndex(p)))
  }

  private syncShipLabel(v: ShipView): void {
    const input = this.input!
    const p = v.planet
    const s = p.session
    const key = sessionStateKey(s)
    const pill = statePill(s)
    const tool = s.recentTools?.length ? s.recentTools[s.recentTools.length - 1] : null
    const detached = input.detachedIds.includes(s.id)
    const fill = p.contextFill
    const compactBadge = input.showCompactBadge && fill?.level === 'critical' && !pill && !p.compactingSince && !s.lastCompactionFailed
    const failed = Boolean(s.lastCompactionFailed && fill)
    const decision = s.pendingDecision
    const asks = key === 'needs_input' && decision
      ? decision.kind === 'question' ? decision.input.questions[0]?.question ?? '' : decisionHeadline(decision)
      : null
    const sub = asks
      ? asks
      : key === 'ended'
        ? 'ended'
        : pill && key !== 'waiting'
          ? pill.label
          : tool
            ? `${tool.name}${tool.summary ? ` · ${tool.summary}` : ''}`
            : pill?.label ?? ''
    const parts = [s.title, key, sub, p.modelFamily, detached, compactBadge, failed, input.statePills, p.muted, p.selected, p.compactingSince ? 'c' : '']
    const labelKey = JSON.stringify(parts)
    if (labelKey === v.labelKey) return
    v.labelKey = labelKey
    const colour = stateColor(key)
    const word = input.statePills === 'label' && pill ? `<span class="ml-1 font-mono text-[9.5px] tracking-[0.1em]" style="color:${colour}">${escape(pill.label)}</span>` : ''
    const title = truncateLabel(s.title)
    v.label.title = s.title
    v.label.className = [
      'group pointer-events-auto absolute left-0 top-0 max-w-[260px] cursor-pointer rounded-lg border bg-[rgba(9,14,24,.84)] px-2.5 py-1.5 transition-[opacity,border-color] duration-700',
      p.selected ? 'border-[rgba(220,235,255,.35)]' : 'border-[rgba(255,255,255,.07)] hover:border-[rgba(255,255,255,.22)]',
    ].join(' ')
    v.label.style.opacity = String((p.muted ? 0.28 : 1) * (key === 'ended' ? 0.6 : 1))
    v.label.innerHTML = `
      <div class="flex items-center gap-1.5 whitespace-nowrap">
        <i class="inline-block h-[7px] w-[7px] shrink-0 rounded-full" style="background:${key === 'idle' || key === 'ended' ? 'transparent' : colour};box-shadow:inset 0 0 0 1.5px ${colour}"></i>
        <span class="font-mono text-[11.5px] font-medium text-text-bright">${escape(title)}</span>
        ${word}
        ${detached ? '<span class="ml-1 text-[10px] text-text-muted" title="Open in its own window">⧉</span>' : ''}
      </div>
      <div data-detail class="mt-0.5 max-w-[240px] truncate font-mono text-[10.5px]" style="color:${pill && key !== 'waiting' ? colour : 'rgb(160 190 225 / .7)'}">${escape(sub)}</div>
      ${p.modelFamily ? `<div data-detail class="font-mono text-[9.5px] uppercase tracking-[0.12em] text-text-muted/70">${escape(p.modelFamily)}</div>` : ''}
      ${p.compactingSince ? `<div class="mt-1 font-mono text-[9.5px] tracking-[0.1em] text-[#bee1ff]" data-compacting="${p.compactingSince}">COMPACTING</div>` : ''}
      ${compactBadge ? `<button type="button" data-action="compact" class="mt-1 rounded border border-[#fa8880]/50 px-1.5 py-0.5 font-mono text-[9.5px] text-[#fa8880]">${Math.round((fill?.fraction ?? 0) * 100)}% · /compact</button>` : ''}
      ${failed ? `<button type="button" data-action="compact-failed" class="mt-1 rounded border border-[#fa8880]/50 px-1.5 py-0.5 font-mono text-[9.5px] text-[#fa8880]">COMPACT FAILED · ${Math.round((fill?.fraction ?? 0) * 100)}%</button>` : ''}`
  }

  private makeBoat(sessionId: string, subagent: Subagent): BoatView {
    const ship = this.ships.get(sessionId)
    const shadow = el('path', { d: BOAT, fill: '#02060c', opacity: 0.45 }, this.layers.shadow)
    const openable = Boolean(subagent.toolUseId)
    const g = el('g', { 'data-boat': `${sessionId}:${subagent.id}`, class: openable ? 'cursor-pointer' : '' }, this.layers.boats)
    const tether = el('line', { stroke: '#59e4f3', 'stroke-width': 0.02, 'stroke-dasharray': '.08 .08', opacity: 0 }, this.layers.boats)
    const ring = el('circle', { r: 20, fill: 'none', stroke: '#59e4f3', 'stroke-width': 1.4, opacity: 0 }, g)
    const body = el('g', {}, g)
    el('path', { d: BOAT, fill: '#7d6a50', stroke: openable ? '#7fe3b0' : '#5d6676', 'stroke-width': 1.3 }, body)
    const oars = el('path', { stroke: '#c9b48e', 'stroke-width': 1.2, 'stroke-linecap': 'round' }, body)
    el('circle', { cx: -2, cy: 0, r: 2.3, fill: '#d9dee6' }, body)
    const lantern = el('circle', { cx: -9, cy: 0, r: 7, fill: 'url(#arch-lantern)', opacity: 0 }, body)
    const label = document.createElement('div')
    label.className = 'pointer-events-none absolute left-0 top-0 whitespace-nowrap font-mono text-[10px] text-[#a9d9c0] opacity-0 transition-opacity duration-500'
    label.textContent = subagent.name
    this.labelLayer.appendChild(label)
    const from = ship ? { x: ship.x, y: ship.y, h: ship.h } : { x: 0, y: 0, h: 0 }
    const isl = ship ? this.islands.get(ship.planet.tagId)?.island : undefined
    const a = isl ? Math.atan2(from.y - isl.y, from.x - isl.x) : 0
    return {
      key: `${sessionId}:${subagent.id}`,
      sessionId,
      subagent,
      g,
      body,
      oars,
      lantern,
      ring,
      tether,
      shadow,
      label,
      x: from.x,
      y: from.y,
      vx: 0,
      vy: 0,
      h: from.h,
      opacity: 0,
      mode: 'out',
      target: isl ? shorePoint(isl, a + 0.3) : from,
      until: 0,
      phase: (subagent.id.charCodeAt(0) % 13) / 2,
    }
  }

  private syncHole(): void {
    const { hole } = this.input!.model
    this.hole.visible = Number.isFinite(hole.x) && this.input!.model.hole !== null
    // The lighthouse stands off the archipelago's bottom-right corner, where
    // the planet map keeps its hole — measured off the islands, which the
    // spread pushed apart, rather than off the planet layout.
    const views = [...this.islands.values()]
    if (views.length) {
      const reach = (v: IslandView) => islandReach(v.island, v.working)
      const maxX = Math.max(...views.map((v) => v.island.x + reach(v)))
      const minY = Math.min(...views.map((v) => v.island.y - reach(v)))
      this.hole.at = { x: maxX + 0.5, y: minY - 0.5 }
    } else this.hole.at = { x: hole.x, y: hole.y }
    this.hole.g.setAttribute('transform', `translate(${fmt(this.hole.at.x)} ${fmt(this.hole.at.y)})`)
  }

  setHoleVisible(visible: boolean): void {
    this.hole.visible = visible
    this.hole.g.style.display = visible ? '' : 'none'
    this.hole.label.style.display = visible ? '' : 'none'
  }

  // ---------------------------------------------------------------- frame

  frame(dtRaw: number, cam: CameraState, viewport: { width: number; height: number }): void {
    const input = this.input
    if (!input) return
    const reduced = input.reduced
    const dt = Math.min(0.05, dtRaw)
    this.t += dt
    const t = this.t
    const z = cam.zoom
    // Ships inflate more gently than planets when zoomed out: an island does not inflate at all.
    const factor = Math.sqrt(bodyZoomFactor(z))
    const compact = z < 42
    const shipScale = (SHIP_LENGTH / HULL_UNITS) * factor
    const toScreen = (p: Point) => ({ x: viewport.width / 2 + (p.x - cam.x) * z, y: viewport.height / 2 - (p.y - cam.y) * z })
    this.world.setAttribute('transform', `matrix(${z} 0 0 ${-z} ${viewport.width / 2 - cam.x * z} ${viewport.height / 2 + cam.y * z})`)
    if (!reduced) this.wavePattern.setAttribute('patternTransform', `translate(${fmt((t * 0.05) % 2.6)} ${fmt(Math.sin(t * 0.15) * 0.1)})`)

    // islands
    for (const v of this.islands.values()) {
      const offset = this.dragged?.kind === 'island' && this.dragged.tagId === v.island.tagId
        ? { x: this.dragged.at.x - v.island.x, y: this.dragged.at.y - v.island.y }
        : null
      v.g.setAttribute('transform', offset ? `translate(${fmt(offset.x)} ${fmt(offset.y)})` : '')
      const surf = v.g.querySelector('[data-surf]')
      if (surf && !reduced) surf.setAttribute('stroke-dashoffset', fmt((t * 0.1) % 0.95))
      const lit = Math.min(1, 0.25 + v.working * 0.25)
      v.lights.forEach((l, i) => {
        const on = i / v.lights.length < lit ? 1 : 0.15
        l.dot.setAttribute('opacity', fmt(on * (0.8 + 0.2 * Math.sin(t * 0.5 + l.phase))))
        l.halo.setAttribute('opacity', fmt(on))
      })
      const f = v.flagAt
      const s = v.island.radius / 185
      const wav = reduced ? 0 : Math.sin(t * 1.2 + v.island.seed) * 3
      v.flag.setAttribute('d', `M${fmt(f.x)} ${fmt(f.y)} Q${fmt(f.x + 10 * s)} ${fmt(f.y + (6 - wav) * s)} ${fmt(f.x + 22 * s)} ${fmt(f.y + (3 - wav * 0.6) * s)} Q${fmt(f.x + 10 * s)} ${fmt(f.y - (4 + wav) * s)} ${fmt(f.x)} ${fmt(f.y - 3 * s)} Z`)
      const c = toScreen({ x: v.island.x + (offset?.x ?? 0), y: v.island.y + (offset?.y ?? 0) + v.island.radius * 0.25 })
      v.plaque.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px) translate(-50%, -50%)`
    }

    // ships
    for (const v of this.ships.values()) {
      const p = v.planet
      const key = sessionStateKey(p.session)
      const view = this.islands.get(p.tagId)
      if (!view) continue
      const isl = this.dragged?.kind === 'island' && this.dragged.tagId === p.tagId
        ? { ...view.island, x: this.dragged.at.x, y: this.dragged.at.y }
        : view.island
      const berth = berthFor(isl, berthGroup(key), Math.max(0, this.groupIndex(p)))
      if (key === 'working' && v.prevKey !== 'working') v.phase = Math.atan2(v.y - isl.y, v.x - isl.x)
      v.prevKey = key

      const drag = this.dragged?.kind === 'ship' && this.dragged.id === v.id ? this.dragged.at : null
      let want: Point
      let heading: number | null = null
      if (drag) {
        want = drag
      } else if (berth.kind === 'orbit') {
        if (!reduced) v.phase += (berth.direction * SHIP_SPEED * 0.8 * dt) / berth.radius
        const ahead = polar(isl, v.phase + berth.direction * 0.22, berth.radius)
        const r = Math.hypot(v.x - isl.x, v.y - isl.y)
        want = r < safeRadius(isl) - 0.2 ? polar(isl, Math.atan2(v.y - isl.y, v.x - isl.x), safeRadius(isl) + 0.4) : routeStep(isl, v, ahead)
      } else {
        want = routeStep(isl, v, berth.at)
        if (Math.hypot(berth.at.x - v.x, berth.at.y - v.y) < 0.5) heading = berth.heading
      }
      if (drag || reduced) {
        if (reduced && !drag) {
          const settled = berth.kind === 'orbit' ? polar(isl, v.phase, berth.radius) : berth.at
          v.x = settled.x
          v.y = settled.y
          v.h = berth.kind === 'orbit' ? v.phase + (berth.direction * Math.PI) / 2 : berth.heading
        } else {
          v.x = want.x
          v.y = want.y
        }
        v.vx = v.vy = 0
      } else {
        steer(v, want, dt, SHIP_SPEED)
        const sp = Math.hypot(v.vx, v.vy)
        if (heading !== null) v.h += angleDiff(heading, v.h) * ease(dt, 1.2)
        else if (sp > 0.04) v.h += angleDiff(Math.atan2(v.vy, v.vx), v.h) * ease(dt, 1.6)
      }

      const sailTarget = p.compactingSince ? 0 : key === 'working' ? 1 : key === 'waiting' ? 0.45 : 0
      v.k = reduced ? sailTarget : v.k + (sailTarget - v.k) * ease(dt, 0.7)
      const bil = reduced ? 0 : Math.sin(t * 0.9 + v.bob) * 0.8
      v.sails.forEach((sl) => {
        const L = sl.len * (0.45 + 0.55 * v.k)
        const bw = 1.5 + 3.5 * v.k + bil * 0.5 * v.k
        sl.path.setAttribute('d', `M0 ${fmt(-L)} Q${fmt(bw * 2)} 0 0 ${fmt(L)} L-3 ${fmt(L)} Q${fmt(bw * 2 - 3)} 0 -3 ${fmt(-L)} Z`)
        sl.path.setAttribute('fill', v.k > 0.5 ? '#ebe5d4' : '#b8b2a2')
      })
      const flag = flagFor(key)
      const wav = reduced ? 0 : Math.sin(t * 1.3 + v.bob) * 2.2
      const fl = key === 'needs_input' ? 22 : 15
      v.pennant.setAttribute('d', flag ? `M-7 -1.6 Q${-7 - fl / 2} ${fmt(wav)} ${-7 - fl} ${fmt(wav * 0.6)} Q${-7 - fl / 2} ${fmt(wav + 2.6)} -7 1.6 Z` : '')
      if (flag) v.pennant.setAttribute('fill', flag)
      // The lantern breathes slowly; nothing on the map blinks (why-orbital § Calm).
      v.halo.setAttribute('opacity', key === 'needs_input' ? fmt(0.7 + (reduced ? 0 : Math.sin(t * 0.8 + v.bob) * 0.18)) : '0')
      v.wins.forEach((r, i) => r.setAttribute('opacity', key === 'working' ? fmt(0.5 + (reduced ? 0 : 0.4 * Math.sin(t * 0.45 + i * 2 + v.bob))) : '0'))
      v.hull.setAttribute('stroke', hsl(p.hue, 55, 62))

      let opacity = p.muted ? 0.28 : 1
      if (key === 'ended') opacity *= 0.55
      if (v.leaveAt !== null) opacity *= Math.max(0, 1 - (t - v.leaveAt) / LEAVE_FADE_SEC)
      v.g.style.opacity = String(opacity)
      v.g.style.filter = key === 'ended' ? 'saturate(.15) brightness(.8)' : ''
      v.shadow.style.opacity = String(opacity * 0.5)
      v.g.style.pointerEvents = v.leaveAt !== null ? 'none' : ''

      const deg = (v.h * 180) / Math.PI
      const roll = reduced ? 1 : 1 + Math.sin(t * 0.8 + v.bob) * 0.025
      v.g.setAttribute('transform', `translate(${fmt(v.x)} ${fmt(v.y)}) scale(${fmt(shipScale)})`)
      v.body.setAttribute('transform', `rotate(${deg.toFixed(2)}) scale(1 ${fmt(roll)})`)
      v.shadow.setAttribute('transform', `translate(${fmt(v.x + 0.06 * factor)} ${fmt(v.y - 0.09 * factor)}) scale(${fmt(shipScale)}) rotate(${deg.toFixed(2)})`)

      // context ring: clockwise from 12 o'clock, as on the planet
      const fill = p.contextFill
      if (fill && !p.leaving) {
        const r = 42
        const steps = Math.max(2, Math.round(48 * fill.fraction))
        let d = ''
        for (let i = 0; i <= steps; i++) {
          const a = Math.PI / 2 - (i / steps) * Math.PI * 2 * fill.fraction
          d += `${i ? 'L' : 'M'}${fmt(Math.cos(a) * r)} ${fmt(Math.sin(a) * r)}`
        }
        v.ring.setAttribute('d', d)
        v.ring.setAttribute('stroke', p.compactingSince ? '#bee1ff' : CONTEXT_COLOURS[fill.level])
        const pulse = fill.level === 'critical' && !reduced ? 0.7 + 0.3 * Math.sin((t * Math.PI * 2) / 1.6) : 1
        v.ring.setAttribute('opacity', fmt((p.compactingSince ? 0.3 : fill.level === 'ok' ? 0.6 : 0.9) * pulse))
      } else v.ring.setAttribute('d', '')
      v.compactRings.forEach((c, i) => {
        if (!p.compactingSince || reduced) return c.setAttribute('opacity', '0')
        const ph = ((t / 3.2 + i * 0.5) % 1)
        c.setAttribute('r', fmt(56 - ph * 26))
        c.setAttribute('opacity', fmt(0.35 * Math.sin(ph * Math.PI)))
      })
      v.select.setAttribute('opacity', p.selected ? '1' : '0')
      if (p.selected) v.select.firstElementChild!.setAttribute('transform', `rotate(${fmt(reduced ? 0 : (t * 360) / 160)})`)

      this.wake(v, t, factor, 0.68 * factor, reduced)

      const lp = toScreen({ x: v.x, y: v.y })
      const below = (SHIP_LENGTH / 2) * factor * z * (0.4 + 0.6 * Math.abs(Math.sin(v.h))) + 10
      // The pier's second berth labels above its ship, so the two moored side by side never overlap.
      const above = berthGroup(key) === 'pier' && this.groupIndex(p) === 1
      v.label.style.transform = above
        ? `translate(${lp.x.toFixed(1)}px, ${(lp.y - below).toFixed(1)}px) translate(-50%, -100%)`
        : `translate(${lp.x.toFixed(1)}px, ${(lp.y + below).toFixed(1)}px) translate(-50%, 0)`
      v.label.style.display = v.leaveAt !== null ? 'none' : ''
      if (compact) v.label.dataset.compact = ''
      else delete v.label.dataset.compact
      const comp = v.label.querySelector<HTMLElement>('[data-compacting]')
      if (comp && t % 0.5 < dt) {
        const since = Number(comp.dataset.compacting)
        const sec = Math.max(0, Math.floor((Date.now() - since) / 1000))
        comp.textContent = sec >= 3 ? `COMPACTING ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : 'COMPACTING'
      }
    }

    // boats
    for (const b of this.boats.values()) {
      const ship = this.ships.get(b.sessionId)
      if (!ship) {
        this.removeBoat(b)
        continue
      }
      const isl = this.islands.get(ship.planet.tagId)?.island
      const state = b.subagent.state
      if (state === 'ended') b.mode = 'back'
      let goal: Point
      if (b.mode === 'back') goal = ship
      else if (b.mode === 'out') goal = b.target
      else {
        goal = b.target
        if (state !== 'needs_input' && this.t > b.until && isl) {
          b.target = shorePoint(isl, Math.atan2(b.target.y - isl.y, b.target.x - isl.x) + (Math.sin(b.phase + this.t) * 0.6))
          b.mode = 'out'
        }
      }
      if (state === 'materializing') goal = polar(ship, ship.h + Math.PI / 2, 0.45 * factor)
      const next = isl && b.mode !== 'back' ? routeStep(isl, b, goal) : goal
      if (reduced) {
        b.x = next.x
        b.y = next.y
      } else steer(b, next, dt, b.mode === 'scout' || state === 'needs_input' ? 0.06 : BOAT_SPEED)
      if (b.mode === 'out' && Math.hypot(b.target.x - b.x, b.target.y - b.y) < 0.15) {
        b.mode = 'scout'
        b.until = this.t + 6 + (b.phase % 5)
      }
      const sp = Math.hypot(b.vx, b.vy)
      if (sp > 0.04) b.h += angleDiff(Math.atan2(b.vy, b.vx), b.h) * ease(dt, 2.2)
      if (b.mode === 'back' && Math.hypot(ship.x - b.x, ship.y - b.y) < 0.4) b.opacity -= dt * 1.2
      else b.opacity = Math.min(1, b.opacity + dt * 0.8)
      if (b.opacity <= 0 && b.mode === 'back') {
        this.removeBoat(b)
        continue
      }
      const row = sp > 0.05 && !reduced ? Math.sin(t * 3 + b.phase) * 4 : 0
      b.oars.setAttribute('d', `M${fmt(-1 + row)} -4 L${fmt(-4 - row)} -11 M${fmt(-1 + row)} 4 L${fmt(-4 - row)} 11`)
      const bs = (SHIP_LENGTH / HULL_UNITS) * 1.4 * factor
      const deg = (b.h * 180) / Math.PI
      b.g.setAttribute('transform', `translate(${fmt(b.x)} ${fmt(b.y)}) scale(${fmt(bs)})`)
      b.body.setAttribute('transform', `rotate(${deg.toFixed(2)})`)
      b.shadow.setAttribute('transform', `translate(${fmt(b.x + 0.04 * factor)} ${fmt(b.y - 0.05 * factor)}) scale(${fmt(bs)}) rotate(${deg.toFixed(2)})`)
      const muted = ship.planet.muted ? 0.28 : 1
      b.g.style.opacity = String(Math.max(0, b.opacity) * muted)
      b.shadow.style.opacity = String(Math.max(0, b.opacity) * muted * 0.45)
      b.lantern.setAttribute('opacity', state === 'needs_input' ? '0.8' : '0')
      const active = this.input!.activeBoatKey === b.key && Boolean(b.subagent.toolUseId)
      b.ring.setAttribute('opacity', active ? '0.8' : '0')
      b.tether.setAttribute('opacity', active ? '0.6' : '0')
      if (active) {
        b.tether.setAttribute('x1', fmt(b.x))
        b.tether.setAttribute('y1', fmt(b.y))
        b.tether.setAttribute('x2', fmt(ship.x))
        b.tether.setAttribute('y2', fmt(ship.y))
      }
      const lp = toScreen(b)
      b.label.style.transform = `translate(${lp.x.toFixed(1)}px, ${(lp.y - 22).toFixed(1)}px) translate(-50%, 0)`
      b.label.style.opacity = z > 70 || ship.planet.selected || active ? String(Math.max(0, b.opacity) * muted) : '0'
    }

    // lighthouse
    if (this.hole.visible) {
      const armed = this.drop === 'armed'
      const refused = this.drop === 'refused'
      const eligible = this.drop !== 'none'
      this.hole.glow.setAttribute('opacity', fmt(armed ? 1 : eligible ? 0.85 : 0.5))
      this.hole.glow.setAttribute('fill', refused ? 'url(#arch-lantern)' : 'url(#arch-warm)')
      this.hole.glow.setAttribute('r', fmt(armed ? 2.4 : eligible ? 2 : 1.6))
      const a = reduced ? 0.6 : t * 0.25
      const tip = 1.12
      const beam = (ang: number) => `M0 ${tip} L${fmt(Math.cos(ang - 0.08) * 3)} ${fmt(tip + Math.sin(ang - 0.08) * 3)} L${fmt(Math.cos(ang + 0.08) * 3)} ${fmt(tip + Math.sin(ang + 0.08) * 3)} Z`
      this.hole.beam.setAttribute('d', beam(a) + beam(a + Math.PI))
      this.hole.beam.setAttribute('opacity', fmt(armed ? 0.18 : 0.07))
      const hp = toScreen({ x: this.hole.at.x, y: this.hole.at.y - 0.4 })
      this.hole.label.style.transform = `translate(${hp.x.toFixed(1)}px, ${(hp.y + 8).toFixed(1)}px) translate(-50%, 0)`
      const count = this.input!.model.hole.count
      const text = refused
        ? "can't end a terminal session"
        : armed
          ? 'release to end'
          : `${count} session${count === 1 ? '' : 's'} · click to browse`
      const html = `<div class="font-semibold text-text-bright/80">HISTORY</div><div class="mt-0.5 tracking-[0.04em]" style="color:${refused ? '#ffbb7b' : ''}">${text}</div>`
      if (this.hole.label.innerHTML !== html) this.hole.label.innerHTML = html
    }
  }

  private removeBoat(b: BoatView): void {
    b.g.remove()
    b.shadow.remove()
    b.tether.remove()
    b.label.remove()
    this.boats.delete(b.key)
  }

  private wake(v: ShipView, t: number, factor: number, stern: number, reduced: boolean): void {
    const sp = Math.hypot(v.vx, v.vy)
    if (!reduced && sp > 0.08 && t - v.lastTrail > 0.14) {
      v.trail.push({ x: v.x - Math.cos(v.h) * stern, y: v.y - Math.sin(v.h) * stern, h: v.h, t })
      v.lastTrail = t
    }
    while (v.trail.length > v.wake.length) v.trail.shift()
    v.wake.forEach((e, i) => {
      const p = v.trail[v.trail.length - 1 - i]
      if (!p || t - p.t > 2.8) return e.setAttribute('opacity', '0')
      const a = (t - p.t) / 2.8
      const spread = (0.05 + a * 0.36) * factor
      const nx = -Math.sin(p.h)
      const ny = Math.cos(p.h)
      const bx = -Math.cos(p.h) * 0.07 * factor
      const by = -Math.sin(p.h) * 0.07 * factor
      e.setAttribute(
        'd',
        `M${fmt(p.x + nx * spread + bx)} ${fmt(p.y + ny * spread + by)} L${fmt(p.x + nx * spread * 0.55)} ${fmt(p.y + ny * spread * 0.55)} M${fmt(p.x - nx * spread + bx)} ${fmt(p.y - ny * spread + by)} L${fmt(p.x - nx * spread * 0.55)} ${fmt(p.y - ny * spread * 0.55)}`
      )
      e.setAttribute('opacity', fmt((1 - a) * 0.34))
    })
  }
}

function steer(o: { x: number; y: number; vx: number; vy: number }, to: Point, dt: number, max: number): void {
  const dx = to.x - o.x
  const dy = to.y - o.y
  const d = Math.hypot(dx, dy)
  const sp = Math.min(max, d * 0.6)
  const wx = d > 1e-4 ? (dx / d) * sp : 0
  const wy = d > 1e-4 ? (dy / d) * sp : 0
  const k = ease(dt, 1.3)
  o.vx += (wx - o.vx) * k
  o.vy += (wy - o.vy) * k
  o.x += o.vx * dt
  o.y += o.vy * dt
}

function rockPoints(): Point[] {
  const out: Point[] = []
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2
    out.push({ x: Math.cos(a) * (0.55 + 0.12 * Math.sin(a * 3)), y: Math.sin(a) * (0.42 + 0.1 * Math.cos(a * 2)) })
  }
  return out
}

function shipPath(points: Point[]): string {
  return pathOf(points)
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
