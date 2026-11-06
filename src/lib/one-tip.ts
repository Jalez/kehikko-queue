import { useEffect, useRef, useSyncExternalStore } from 'react'

/**
 * One chart tooltip on the page at a time, and none once the pointer or the page has gone.
 *
 * Every chart that draws a tooltip asks here before showing it (`showTip`): showing one hides any
 * other. The page hides it whatever chart owns it when the pointer leaves the document (the frame),
 * the window loses focus or is hidden, the page scrolls or is resized, Escape is pressed, or a press
 * lands outside the chart. The host saying this page is off screen (`kehikot.visible` false) hides it
 * too, through `hideTip()` called where the host is read.
 *
 * Focus shows a tooltip only when it came from the keyboard (`fromKeyboard`): a click that focuses a
 * chart leaves no tooltip pinned once the pointer goes. A tap shows one for `TOUCH_MS`, or until a tap
 * elsewhere.
 */

export const TOUCH_MS = 4000

type Owner = { key: symbol; el: Element | null; keyboard: boolean }

let owner: Owner | null = null
let keyboard = true
let timer: ReturnType<typeof setTimeout> | undefined
let installed = false
const listeners = new Set<() => void>()

const emit = () => {
  for (const listener of listeners) listener()
}

/** Show `key`'s tooltip, hiding any other. `touch` hides it again after `TOUCH_MS`. */
export function showTip(key: symbol, el: Element | null, how: { touch?: boolean; keyboard?: boolean } = {}) {
  clearTimeout(timer)
  timer = how.touch ? setTimeout(() => hideTip(key), TOUCH_MS) : undefined
  const next: Owner = { key, el, keyboard: Boolean(how.keyboard) }
  if (owner && owner.key === next.key && owner.el === next.el && owner.keyboard === next.keyboard) return
  owner = next
  emit()
}

/** Hide `key`'s tooltip, or with no key whichever is shown. */
export function hideTip(key?: symbol) {
  if (!owner || (key && owner.key !== key)) return
  clearTimeout(timer)
  owner = null
  emit()
}

/** Whether the last input was a key rather than a pointer: focus shows a tooltip only then. */
export const fromKeyboard = () => keyboard

/** For tests: nothing shown, the keyboard last. */
export function resetTips() {
  hideTip()
  keyboard = true
}

function install() {
  if (installed || typeof document === 'undefined') return
  installed = true
  const hide = () => hideTip()
  document.addEventListener(
    'keydown',
    (event) => {
      keyboard = true
      if (event.key === 'Escape') hide()
    },
    true,
  )
  document.addEventListener(
    'pointerdown',
    (event) => {
      keyboard = false
      const target = event.target
      if (owner?.el && target instanceof Node && owner.el.contains(target)) return
      hide()
    },
    true,
  )
  document.addEventListener('mousedown', () => (keyboard = false), true)
  /* The pointer leaving the page, which in a frame is leaving the module. A finger lifting says the
     same with a null `relatedTarget`, so only a mouse or a pen counts. */
  document.documentElement.addEventListener('mouseleave', hide)
  document.addEventListener('pointerout', (event) => {
    if (!event.relatedTarget && event.pointerType !== 'touch') hide()
  })
  window.addEventListener('blur', hide)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hide()
  })
  /* Any scroller (capture). A keyboard tooltip stays: focusing a chart may scroll it into view. */
  window.addEventListener(
    'scroll',
    () => {
      if (owner?.keyboard && owner.el && owner.el === document.activeElement) return
      hide()
    },
    true,
  )
  window.addEventListener('resize', hide)
}

function subscribe(listener: () => void) {
  install()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A chart's own key, and whether its tooltip is the one shown. It is hidden when the chart goes. */
export function useTip(): { key: symbol; mine: boolean } {
  const ref = useRef<symbol | null>(null)
  if (!ref.current) ref.current = Symbol('tip')
  const key = ref.current
  const mine = useSyncExternalStore(
    subscribe,
    () => owner?.key === key,
    () => false,
  )
  useEffect(() => () => hideTip(key), [key])
  return { key, mine }
}
