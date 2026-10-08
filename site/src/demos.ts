/**
 * The live demos the landing page frames. The demo pages themselves are
 * built separately (site/demo, vite.demo.config.ts) into public/demo; this
 * file is the landing's side of the contract with them. See DemoFrame.astro.
 */

export type DemoName = 'map' | 'session' | 'phone'

interface Viewport {
  /** The size the demo page lays out at, before it is scaled to its frame. */
  width: number
  height: number
  /** The frame's aspect ratio, from the canvas placeholders. */
  aspect: string
}

/**
 * The app inside each iframe lays out as on a real screen and is scaled
 * down to the frame, so the frame shows a desktop layout rather than a
 * cramped one. Tuned during the fidelity pass against the canvas.
 */
export const DEMO_VIEWPORTS: Record<DemoName, Viewport> = {
  map: { width: 1440, height: 900, aspect: '16 / 10' },
  session: { width: 960, height: 600, aspect: '16 / 10' },
  phone: { width: 390, height: 844, aspect: '9 / 19.5' },
}

/**
 * At or below this viewport width no demo iframe is created, so a phone
 * visitor downloads none of the demo code (three.js included) and sees the
 * posters only.
 */
export const NARROW_MAX_WIDTH = 760

/** What the demo page posts to its parent once it has rendered. */
export const DEMO_READY_MESSAGE = 'orbital-demo-ready'

interface DemoFrameSpec {
  demo: DemoName
  src: string
  /** The iframe's accessible name. */
  title: string
  /** The poster's alt text: what the scene shows. */
  alt: string
  caption: string
}

export const DEMO_FRAMES = {
  'map-hero': {
    demo: 'map',
    src: '/demo/map/?scene=hero',
    title: 'Live demo of the Orbital map',
    alt: 'The Orbital map: Claude Code sessions drawn as planets, one working, one waiting for your input, one done, and one with its subagents circling it as moons.',
    caption: 'Live demo · click a planet',
  },
  'map-states': {
    demo: 'map',
    src: '/demo/map/?scene=states',
    title: 'Live demo of the Orbital map and its session states',
    alt: 'The Orbital map with a session in each state: needs input, done, working, and waiting for its subagents.',
    caption: 'Live demo · click a planet',
  },
  session: {
    demo: 'session',
    src: '/demo/session/',
    title: 'Live demo of an Orbital session panel',
    alt: 'An Orbital session panel: the chat with Claude, a permission request with the full command, and the diff of an edit.',
    caption: 'Live demo',
  },
  'phone-answer': {
    demo: 'phone',
    src: '/demo/phone/?screen=answer',
    title: 'Live demo of the Orbital phone app answering a session',
    alt: 'The Orbital phone app answering a session that needs input.',
    caption: 'Live demo',
  },
  'phone-new': {
    demo: 'phone',
    src: '/demo/phone/?screen=new',
    title: 'Live demo of the Orbital phone app starting a session',
    alt: 'The Orbital phone app starting a new session.',
    caption: 'Live demo',
  },
} satisfies Record<string, DemoFrameSpec>

export type DemoId = keyof typeof DEMO_FRAMES

/** Generated from the demos themselves by the image script, not by the build. */
export const posterSrc = (id: DemoId): string => `/demo-images/${id}.webp`
