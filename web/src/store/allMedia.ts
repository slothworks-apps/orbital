import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { joinPage } from '../lib/allMedia'
import type { AllMediaItem } from '../lib/types'

/** Items asked for per page. */
const PAGE = 60

interface Held {
  key: string
  items: AllMediaItem[]
  next: string | null
  done: boolean
  failed: boolean
  pages: number
}

const fresh = (key: string): Held => ({ key, items: [], next: null, done: false, failed: false, pages: 0 })

export interface AllMediaList {
  items: AllMediaItem[]
  /** Whether the server has said there is nothing after what is held. */
  done: boolean
  /** The last page failed; `more` asks again. */
  failed: boolean
  /** Pages landed since the list was read from the top — a short page still counts, so a caller can ask on. */
  pages: number
  /** Asks for the next page, once at a time; nothing when done. */
  more(): void
}

/**
 * The gallery of every session as this client has paged it (spec
 * 2026-10-13-all-sessions-gallery-design): read from the top whenever it
 * mounts or the tag filter changes, then a page at a time as the grid
 * scrolls. Nothing polls and nothing arrives on its own: what was held when
 * the user looked stays put until they look again.
 */
export function useAllMedia(tagIds: readonly number[]): AllMediaList {
  const tagKey = tagIds.join(',')
  const [state, setState] = useState<Held>(fresh(tagKey))
  const loading = useRef<string | null>(null)
  const latest = useRef(state)
  latest.current = state

  const more = useCallback(() => {
    const held = latest.current.key === tagKey ? latest.current : fresh(tagKey)
    if (held.done || loading.current === tagKey) return
    loading.current = tagKey
    const tags = tagKey ? tagKey.split(',').map(Number) : []
    api
      .allMedia({ tags, limit: PAGE, ...(held.next ? { cursor: held.next } : {}) })
      .then((page) => {
        // An answer for a filter the user has since changed is dropped.
        if (loading.current !== tagKey) return
        setState({
          key: tagKey, items: joinPage(held.items, page.items), next: page.next, done: page.next === null, failed: false,
          pages: held.pages + 1,
        })
      })
      .catch(() => {
        if (loading.current === tagKey) setState({ ...held, failed: true })
      })
      .finally(() => {
        if (loading.current === tagKey) loading.current = null
      })
  }, [tagKey])

  useEffect(() => {
    loading.current = null
    setState(fresh(tagKey))
    more()
  }, [tagKey, more])

  const current = state.key === tagKey ? state : fresh(tagKey)
  return { items: current.items, done: current.done, failed: current.failed, pages: current.pages, more }
}
