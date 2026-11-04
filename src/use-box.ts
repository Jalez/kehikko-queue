import { useLayoutEffect, useState, type RefObject } from 'react'

import type { Box } from './glance.ts'

/**
 * The size of the page's own box, as it changes: the container on the canvas, resized by the person.
 * Null until measured, and where there is nothing to measure with; a box with no size (not laid out)
 * is not a measurement.
 */
export function useBox(element: RefObject<HTMLElement | null>): Box | null {
  const [box, setBox] = useState<Box | null>(null)
  useLayoutEffect(() => {
    const at = element.current
    if (!at || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect || (rect.width === 0 && rect.height === 0)) return
      const next = { width: Math.round(rect.width), height: Math.round(rect.height) }
      setBox((was) => (was && was.width === next.width && was.height === next.height ? was : next))
    })
    watch.observe(at)
    return () => watch.disconnect()
  }, [element])
  return box
}
