import { describe, expect, test } from 'bun:test'
import { HEADER_MENUS, LIMITS } from 'kehikot-module-protocol'

import { LABEL_FIT, SHOWING, headerItems, pressed } from '../src/header.ts'

/*
 * The host draws a container's header in one row, at every width a person
 * drags it to: words at 300 pixels and up, icons under 300, one "⋯" under 220,
 * and pinned runs only at 360 and up. What a module controls is what goes in
 * it, so that is what is held here, at 380, 280 and 200 pixels.
 */
const WIDTHS = [380, 280, 200] as const
const mode = (width: number) => (width < 220 ? 'merged' : width < 300 ? 'icons' : 'words')

describe('the header', () => {
  test('one View switch, on the view the page is showing', () => {
    for (const showing of SHOWING) {
      const items = headerItems(showing)
      expect(items.map((item) => `${HEADER_MENUS[item.kind]}:${item.id}`)).toEqual(['view:show'])
      expect(items[0]?.kind === 'switch' && items[0].value).toBe(showing)
    }
  })

  test('fits at 380, 280 and 200 pixels: short labels, and nothing pinned beyond what a narrow header drops', () => {
    for (const width of WIDTHS) {
      const items = headerItems('open')
      /* Under 360 pixels the host draws no pinned run; at most PINNED_MAX above it. */
      const pinned = items.filter((item) => item.kind === 'run' && item.pinned)
      expect(pinned.length).toBeLessThanOrEqual(width >= 360 ? LIMITS.PINNED_MAX : items.length)
      for (const item of items) {
        expect(item.label.length).toBeLessThanOrEqual(LABEL_FIT)
        for (const option of 'options' in item ? item.options : []) expect(option.label.length).toBeLessThanOrEqual(LABEL_FIT)
        /* A pinned run is drawn as an icon button: it needs an icon at every width. */
        if (item.kind === 'run' && item.pinned) expect(item.icon).toBeDefined()
      }
      expect(['words', 'icons', 'merged']).toContain(mode(width))
    }
  })

  test('only a harmless item is marked for agents, and never a confirmed run', () => {
    for (const item of headerItems('all')) {
      if (item.kind === 'run') expect(item.agents && item.confirm).toBeFalsy()
      if (item.agents) expect(item.kind === 'switch' || item.kind === 'go' || item.kind === 'toggle').toBe(true)
    }
  })

  test('a press is a view, or a sentence saying why it was not taken', () => {
    expect(pressed('show', 'all')).toBe('all')
    expect(pressed('show', 'everything')).toContain('not a view')
    expect(pressed('other', 'all')).toContain('nothing called')
  })
})
