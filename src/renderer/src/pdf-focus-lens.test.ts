import { describe, expect, it } from 'vitest'
import { focusLensLayout } from './pdf-focus-lens'

describe('spotlight magnification lens geometry', () => {
  it('centers and magnifies a multiline reading unit', () => {
    const layout = focusLensLayout([{ x: .2, y: .3, width: .5, height: .03 }, { x: .2, y: .34, width: .4, height: .03 }], 600, 800, 1.25)!
    expect(layout.effectiveMagnification).toBeCloseTo(1.25)
    expect(layout.destination.width).toBeGreaterThan(layout.source.width)
    expect(layout.destination.height).toBeGreaterThan(layout.source.height)
  })

  it('constrains the lens at every page edge without cropping its source', () => {
    for (const rect of [{ x: 0, y: 0 }, { x: .9, y: 0 }, { x: 0, y: .95 }, { x: .9, y: .95 }]) {
      const layout = focusLensLayout([{ ...rect, width: .1, height: .05 }], 500, 700, 1.6)!
      expect(layout.destination.x).toBeGreaterThanOrEqual(0)
      expect(layout.destination.y).toBeGreaterThanOrEqual(0)
      expect(layout.destination.x + layout.destination.width).toBeLessThanOrEqual(500)
      expect(layout.destination.y + layout.destination.height).toBeLessThanOrEqual(700)
    }
  })

  it('reduces the effective scale for units too large to fit on the page', () => {
    const layout = focusLensLayout([{ x: .02, y: .1, width: .96, height: .8 }], 600, 800, 1.6)!
    expect(layout.effectiveMagnification).toBeLessThan(1.6)
    expect(layout.destination.width).toBeLessThanOrEqual(600)
    expect(layout.destination.height).toBeLessThanOrEqual(800)
  })

  it('rejects empty or invalid page geometry', () => {
    expect(focusLensLayout([], 600, 800, 1.25)).toBeNull()
    expect(focusLensLayout([{ x: 0, y: 0, width: .5, height: .1 }], 0, 800, 1.25)).toBeNull()
  })
})
