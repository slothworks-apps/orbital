import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { advance, useFrame, useThree, type RootState } from '@react-three/fiber'
import { FrameScheduler, MAX_FRAME_DELTA_SEC } from './frameSchedule'

/**
 * Wires `FrameScheduler` (`frameSchedule.ts`) into a `frameloop="demand"`
 * canvas. The scheduler draws capped frames with r3f's `advance`; r3f still
 * draws a frame of its own when a three.js prop changes or the canvas
 * resizes, and those go through the same begin/end bracket.
 *
 * The bracket is two frame callbacks: one ahead of everything (the lowest
 * priority on the map), one after everything. The one after has to be a
 * positive priority, and a positive priority takes rendering over from r3f —
 * so it renders the scene itself, then closes the frame.
 */

const FrameBudgetContext = createContext<FrameScheduler | null>(null)

/** Ahead of `SimStepper` (-1), so the frame's time step is known before anything advances. */
const BEGIN_PRIORITY = -2
const END_PRIORITY = 1

export function FrameBudget({
  scheduler,
  children,
}: {
  scheduler: FrameScheduler
  children: ReactNode
}) {
  const get = useThree((s) => s.get)
  // Subscribed only to re-render on a resize, which the effect below turns
  // into a frame: resizing clears the drawing buffer, and the labels are
  // placed in screen px.
  useThree((s) => s.size)

  useEffect(() => {
    scheduler.draw = (now) => advance(now, true, get())
    scheduler.request()
    return () => {
      scheduler.draw = null
    }
  }, [scheduler, get])

  // Every render of the map's children is a prop or store change something
  // may need to show — ask for a frame. A render that changed nothing costs
  // one frame, and only while the map is not already drawing.
  useEffect(() => {
    scheduler.request()
  })

  useFrame((_, delta) => scheduler.beginFrame(delta), BEGIN_PRIORITY)
  useFrame(({ gl, scene, camera }) => {
    gl.render(scene, camera)
    scheduler.endFrame()
  }, END_PRIORITY)

  return <FrameBudgetContext.Provider value={scheduler}>{children}</FrameBudgetContext.Provider>
}

/** The scheduler, for code that changes what the map shows without a render (refs, pointer state). Null outside a `FrameBudget`. */
export function useFrameScheduler(): FrameScheduler | null {
  return useContext(FrameBudgetContext)
}

/**
 * `useFrame` for the map. The callback gets the frame's budgeted time step
 * rather than r3f's raw one, and returns whether it is still moving
 * something: true keeps frames coming (under the cap), false lets the map
 * stop drawing once nothing else moves either.
 *
 * Outside a `FrameBudget` (tests, the sandbox) it is plain `useFrame` with
 * the raw step clamped to MAX_FRAME_DELTA_SEC.
 */
export function useMapFrame(
  callback: (state: RootState, delta: number) => boolean,
  priority?: number,
): void {
  const scheduler = useContext(FrameBudgetContext)
  useFrame((state, delta) => {
    const step = scheduler ? scheduler.frameDelta : Math.min(delta, MAX_FRAME_DELTA_SEC)
    if (callback(state, step)) scheduler?.markMoving()
  }, priority)
}

/**
 * Asks for a frame after every render of the calling component — for map
 * components whose own state (hover, a flash) changes what the next frame
 * draws without the map re-rendering around them.
 */
export function useFrameOnRender(): void {
  const scheduler = useContext(FrameBudgetContext)
  useEffect(() => {
    scheduler?.request()
  })
}
