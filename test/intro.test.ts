import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { INTRO_FILE, INTRO_VIEW, introFromFile, introOf, introSeconds } from 'kehikot-module-protocol'

import { DECLARED } from '../manifest.ts'

/*
 * This module's introduction (protocol 2.57.0): `intro.json` at the repository's root, the same object
 * in the manifest. A host reads the file without running the module, so it must parse on its own,
 * every picture included (a picture that does not parse is dropped silently, so it is checked here).
 */

const ROOT = join(import.meta.dir, '..')
const file = readFileSync(join(ROOT, INTRO_FILE), 'utf8')

describe('the introduction', () => {
  test('the file parses whole, and the manifest carries the same', () => {
    const intro = introFromFile(file)
    expect(intro).not.toBeNull()
    expect(introOf(DECLARED)).toEqual(intro)
    expect(JSON.parse(file)).toEqual(intro as never)
  })

  test('three to six slides, about twenty seconds, every slide with a picture', () => {
    const intro = introFromFile(file)!
    expect(intro.slides.length).toBeGreaterThanOrEqual(3)
    expect(intro.slides.length).toBeLessThanOrEqual(6)
    expect(introSeconds(intro)).toBeLessThanOrEqual(30)
    for (const slide of intro.slides) expect(slide.art, slide.title).toBeDefined()
  })

  test('every shape stays on the canvas', () => {
    for (const slide of introFromFile(file)!.slides) {
      for (const shape of slide.art!.shapes) {
        const right = 'w' in shape ? shape.x + shape.w : 'widths' in shape ? shape.x + Math.max(...shape.widths) : shape.x
        const bottom = 'h' in shape ? shape.y + shape.h : 'widths' in shape ? shape.y + (shape.widths.length - 1) * (shape.gap ?? 9) + 4 : shape.y
        expect(right, `${slide.title}: ${shape.kind}`).toBeLessThanOrEqual(INTRO_VIEW.width)
        expect(bottom, `${slide.title}: ${shape.kind}`).toBeLessThanOrEqual(INTRO_VIEW.height)
      }
    }
  })
})
