// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { getPdfSelectionPageRange, shouldRenderPdfPage } from './pdf-selection'

afterEach(() => { document.body.replaceChildren(); window.getSelection()?.removeAllRanges() })

describe('PDF text selection rendering', () => {
  it('keeps every page between both selection endpoints rendered', () => {
    const viewer = document.createElement('div')
    const first = page(2, 'selection starts here')
    const last = page(7, 'and ends here')
    viewer.append(first, last)
    document.body.append(viewer)
    const range = document.createRange()
    range.setStart(first.firstChild!.firstChild!, 0)
    range.setEnd(last.firstChild!.firstChild!, 8)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    expect(getPdfSelectionPageRange(selection, viewer)).toEqual({ start: 2, end: 7 })
    expect(shouldRenderPdfPage(2, 7, 2, { start: 2, end: 7 })).toBe(true)
    expect(shouldRenderPdfPage(5, 7, 2, { start: 2, end: 7 })).toBe(true)
  })

  it('releases the retained range when selection collapses or leaves the viewer', () => {
    const viewer = document.createElement('div')
    const inside = page(3, 'inside')
    const outside = page(9, 'outside')
    viewer.append(inside)
    document.body.append(viewer, outside)
    const selection = window.getSelection()!
    selection.collapse(inside.firstChild!.firstChild!, 1)
    expect(getPdfSelectionPageRange(selection, viewer)).toBeNull()

    const range = document.createRange()
    range.setStart(inside.firstChild!.firstChild!, 0)
    range.setEnd(outside.firstChild!.firstChild!, 2)
    selection.removeAllRanges()
    selection.addRange(range)
    expect(getPdfSelectionPageRange(selection, viewer)).toBeNull()
  })

  it('preserves the existing lazy-render radius outside a selection', () => {
    expect(shouldRenderPdfPage(7, 5, 0.5, null)).toBe(true)
    expect(shouldRenderPdfPage(7, 5, 1, null)).toBe(true)
    expect(shouldRenderPdfPage(7, 5, 1.25, null)).toBe(false)
  })
})

function page(pageNumber: number, text: string): HTMLElement {
  const host = document.createElement('div')
  host.className = 'pdf-page'
  host.dataset.pageNumber = String(pageNumber)
  const layer = document.createElement('div')
  layer.className = 'textLayer'
  layer.append(document.createTextNode(text))
  host.append(layer)
  return host
}
