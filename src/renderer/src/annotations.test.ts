import { describe, expect, it } from 'vitest'
import type { Annotation } from '../../shared/types'
import { findAnnotationAt, normalizePdfPoint, normalizePdfRect } from './annotations'

describe('annotation geometry', () => {
  it('normalizes points and rectangles against non-zero page boxes', () => {
    expect(normalizePdfPoint([60, 120], [10, 20, 110, 220])).toEqual({ x: 0.5, y: 0.5 })
    const rect = normalizePdfRect([90, 180], [30, 60], [10, 20, 110, 220])
    expect(rect.x).toBeCloseTo(0.2)
    expect(rect.y).toBeCloseTo(0.2)
    expect(rect.width).toBeCloseTo(0.6)
    expect(rect.height).toBeCloseTo(0.6)
  })

  it('finds the topmost highlight or ink stroke on a page', () => {
    const annotations: Annotation[] = [
      { id: 'highlight', type: 'highlight', pageIndex: 0, rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.2 }], color: '#facc15', opacity: 0.4, createdAt: '' },
      { id: 'ink', type: 'ink', pageIndex: 0, points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }], width: 2, color: '#000000', opacity: 1, createdAt: '' },
    ]
    expect(findAnnotationAt(annotations, 0, { x: 0.25, y: 0.25 })?.id).toBe('ink')
    expect(findAnnotationAt(annotations, 1, { x: 0.25, y: 0.25 })).toBeUndefined()
  })
})
