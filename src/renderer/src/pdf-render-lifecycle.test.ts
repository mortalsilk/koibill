import { describe, expect, it, vi } from 'vitest'
import { isPdfRenderCancellation, observePdfRender } from './pdf-render-lifecycle'

describe('PDF render lifecycle', () => {
  it('recognizes the cancellation shape used by PDF.js', () => {
    expect(isPdfRenderCancellation({ name: 'RenderingCancelledException', message: 'Rendering cancelled, page 1' })).toBe(true)
    expect(isPdfRenderCancellation(new Error('Rendering cancelled while zooming'))).toBe(true)
    expect(isPdfRenderCancellation(new Error('Canvas failed'))).toBe(false)
  })

  it('settles an expected cancellation without reporting it', async () => {
    const report = vi.fn()
    await expect(observePdfRender(Promise.reject({ name: 'RenderingCancelledException' }), () => true, report)).resolves.toBe(false)
    expect(report).not.toHaveBeenCalled()
  })

  it('reports real render failures without leaving a rejected promise behind', async () => {
    const error = new Error('Canvas failed')
    const report = vi.fn()
    await expect(observePdfRender(Promise.reject(error), () => false, report)).resolves.toBe(false)
    expect(report).toHaveBeenCalledWith(error)
  })
})
