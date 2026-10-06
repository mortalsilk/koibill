import { describe, expect, it } from 'vitest'
import { anchorScrollCorrection, normalizeWheelDelta, zoomForWheel } from './pdf-wheel-zoom'

describe('continuous PDF wheel zoom', () => {
  it('normalizes pixel, line, and page wheel deltas', () => {
    expect(normalizeWheelDelta(10, 0, 800)).toBe(10)
    expect(normalizeWheelDelta(2, 1, 800)).toBe(32)
    expect(normalizeWheelDelta(1, 2, 800)).toBe(800)
  })

  it('uses an exponential curve with bounded zoom', () => {
    expect(zoomForWheel(1, -100)).toBeGreaterThan(1)
    expect(zoomForWheel(1, 100)).toBeLessThan(1)
    expect(zoomForWheel(4, -10_000)).toBe(4)
    expect(zoomForWheel(.25, 10_000)).toBe(.25)
  })

  it('calculates scroll correction that preserves the pointer anchor', () => {
    const correction = anchorScrollCorrection({ pageNumber: 2, normalizedX: .25, normalizedY: .75, clientX: 400, clientY: 300 }, { left: 100, top: 50, width: 800, height: 1000 })
    expect(correction).toEqual({ left: -100, top: 500 })
  })
})
