// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { SemanticReflow } from './SemanticReflow'

const scrollIntoView = vi.fn()

beforeEach(() => {
  scrollIntoView.mockClear()
  Element.prototype.scrollIntoView = scrollIntoView
  window.koibill = {
    getReflowCache: vi.fn(async () => null),
    saveReflowCache: vi.fn(async () => undefined),
    showSelectionMenu: vi.fn(),
  } as unknown as typeof window.koibill
})

describe('SemanticReflow viewport stability', () => {
  it('aligns to the current page once while surrounding pages are inserted', async () => {
    const pdf = {
      numPages: 3,
      getPage: vi.fn(async (pageNumber: number) => fakePage(pageNumber)),
    } as unknown as PDFDocumentProxy
    render(<SemanticReflow
      pdf={pdf}
      sessionId="session"
      documentId="document"
      fingerprint="fingerprint"
      documentName="paper.pdf"
      currentPage={2}
      query=""
      typography={{ fontScale: 1, lineHeight: 1.65, measure: 68 }}
      onTypography={vi.fn()}
      onPage={vi.fn()}
      onSource={vi.fn()}
      onDocument={vi.fn()}
    />)
    await waitFor(() => expect(screen.getByText('3/3 pages')).toBeTruthy())
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('ignores layout-generated scroll events while extraction is incomplete', async () => {
    const never = new Promise<PDFPageProxy>(() => undefined)
    const onPage = vi.fn()
    const pdf = {
      numPages: 2,
      getPage: vi.fn((pageNumber: number) => pageNumber === 2 ? Promise.resolve(fakePage(2)) : never),
    } as unknown as PDFDocumentProxy
    const { container } = render(<SemanticReflow
      pdf={pdf} sessionId="session" documentId="document" fingerprint="fingerprint" documentName="paper.pdf"
      currentPage={2} query="" typography={{ fontScale: 1, lineHeight: 1.65, measure: 68 }}
      onTypography={vi.fn()} onPage={onPage} onSource={vi.fn()} onDocument={vi.fn()}
    />)
    await waitFor(() => expect(container.textContent).toContain('Content for page 2.'))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const block = Array.from(container.querySelectorAll<HTMLElement>('[data-semantic-block]')).find((item) => item.textContent?.includes('Content for page 2.'))!
    block.closest<HTMLElement>('[data-semantic-block]')!.dataset.pageNumber = '1'
    const host = container.querySelector<HTMLElement>('.semantic-reflow')!
    fireEvent.scroll(host)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(onPage).not.toHaveBeenCalled()
    fireEvent.wheel(host, { deltaY: 20 })
    fireEvent.scroll(host)
    await waitFor(() => expect(onPage).toHaveBeenCalledWith(1))
  })
})

function fakePage(pageNumber: number): PDFPageProxy {
  return {
    getTextContent: vi.fn(async () => ({ items: [{ str: `Content for page ${pageNumber}.`, transform: [10, 0, 0, 10, 50, 700], width: 180, height: 10, hasEOL: true, fontName: 'Body' }], styles: {}, lang: null })),
    getStructTree: vi.fn(async () => null),
    getViewport: vi.fn(() => ({
      width: 600,
      height: 800,
      convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
    })),
  } as unknown as PDFPageProxy
}
