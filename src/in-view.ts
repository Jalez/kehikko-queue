import { useEffect, useRef, type RefObject } from 'react'

/**
 * Watching whether the page's rows are in view, so a run still asking that sits
 * in view on a visible page for a moment counts as seen by the person. The host
 * says when the page is hidden (protocol 2.45.0); a hidden page is not being
 * looked at, and nothing is watched then.
 */

/** How long a row asking for the person must sit in view to count as seen. */
export const SEEN_IN_VIEW_MS = 2000

/** Watches one row element: `told` is called `true` when it is in view, `false` when not; answers the stop. */
export type Observe = (element: Element, told: (inView: boolean) => void) => () => void

/** The page's own: one IntersectionObserver for every watched row. No observer, no watching. */
export const observeInView: Observe = (() => {
  if (typeof IntersectionObserver === 'undefined') return () => () => {}
  const watched = new Map<Element, (inView: boolean) => void>()
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) watched.get(entry.target)?.(entry.isIntersecting)
  })
  return (element, told) => {
    watched.set(element, told)
    io.observe(element)
    return () => {
      watched.delete(element)
      io.unobserve(element)
    }
  }
})()

/** Whether the host has the page on screen: `true` until it says otherwise. */
export function usePageVisible(visible: boolean | undefined): boolean {
  return visible !== false
}

/** While `active`, watches `element` and calls `onSeen` once it has been in view for `ms`. Leaving view first cancels. */
export function useSeenInView(element: RefObject<HTMLElement | null>, active: boolean, onSeen: () => void, observe: Observe = observeInView, ms: number = SEEN_IN_VIEW_MS): void {
  const seen = useRef(onSeen)
  seen.current = onSeen
  useEffect(() => {
    const row = element.current
    if (!active || !row) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = observe(row, (inView) => {
      if (inView) {
        if (timer === undefined) timer = setTimeout(() => {
          timer = undefined
          seen.current()
        }, ms)
      } else if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    })
    return () => {
      stop()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [element, active, observe, ms])
}
