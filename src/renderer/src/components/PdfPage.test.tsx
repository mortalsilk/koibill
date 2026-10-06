// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import '../styles.css'

vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  TextLayerBuilder: class {
    div = document.createElement('div')
    render = vi.fn(async () => undefined)
    cancel = vi.fn()
  },
}))

import { drawFocusLens, PdfPage } from './PdfPage'

const unit = {
  id: '1:paragraph:0', pageNumber: 1, type: 'paragraph' as const, text: 'Focused passage',
  rects: [{ x: .1, y: .2, width: .5, height: .04 }],
}

function props(overrides: Partial<ComponentProps<typeof PdfPage>> = {}): ComponentProps<typeof PdfPage> {
  return {
    pageNumber: 1, shouldRender: false, getPage: vi.fn(), scale: 1, rotation: 0, annotations: [], tool: 'select',
    highlightColor: '#ffff00', penColor: '#000000', penWidth: 2, documentId: 'document', sourceFingerprint: 'fingerprint',
    documentName: 'paper.pdf', selectedAnnotationId: null, focusEnabled: true, surroundingVisibility: .15, focusMagnification: 1.25, selectionActive: false,
    activeReadingUnit: unit, onReadingMap: vi.fn(), onFocusAt: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn(), onSelectAnnotation: vi.fn(),
    ...overrides,
  }
}

describe('PDF spotlight overlay', () => {
  it('renders a padded cutout without intercepting PDF interaction', () => {
    const { container } = render(<PdfPage {...props()}/>)
    const overlay = container.querySelector<SVGElement>('.spotlight-overlay')!
    const veil = overlay.querySelector(':scope > rect')!
    const cutout = overlay.querySelector('mask rect[fill="black"]')!
    expect(veil.getAttribute('opacity')).toBe('0.85')
    expect(Number(cutout.getAttribute('width'))).toBeGreaterThan(500)
    expect(overlay.style.pointerEvents).toBe('none')
  })

  it('supports the full configured visibility range', () => {
    const { container, rerender } = render(<PdfPage {...props({ surroundingVisibility: .05 })}/>)
    expect(container.querySelector('.spotlight-overlay > rect')?.getAttribute('opacity')).toBe('0.95')
    rerender(<PdfPage {...props({ surroundingVisibility: .4 })}/>)
    expect(container.querySelector('.spotlight-overlay > rect')?.getAttribute('opacity')).toBe('0.6')
  })

  it('does not render a mask when focus mode is disabled', () => {
    const { container } = render(<PdfPage {...props({ focusEnabled: false })}/>)
    expect(container.querySelector('.spotlight-overlay')).toBeNull()
  })

  it('keeps the magnification lens pointer-transparent and hides it during selection', () => {
    const { container } = render(<PdfPage {...props({ selectionActive: true })}/>)
    const lens = container.querySelector<HTMLCanvasElement>('.focus-lens')!
    expect(lens.style.pointerEvents).toBe('none')
    expect(lens.classList.contains('selection-active')).toBe(true)
  })

  it('composites the rendered page and annotations into the lens', () => {
    const lens = document.createElement('canvas')
    const page = document.createElement('canvas'); page.width = 600; page.height = 800; page.style.width = '600px'; page.style.height = '800px'
    const annotations = document.createElement('canvas'); annotations.width = 600; annotations.height = 800
    const drawImage = vi.fn()
    vi.spyOn(lens, 'getContext').mockReturnValue({ drawImage, save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), fillStyle: '', strokeStyle: '', lineWidth: 1 } as unknown as CanvasRenderingContext2D)
    drawFocusLens(lens, page, annotations, unit, 1.25, false)
    expect(drawImage).toHaveBeenCalledTimes(2)
    expect(drawImage.mock.calls[0][0]).toBe(page)
    expect(drawImage.mock.calls[1][0]).toBe(annotations)
    drawImage.mockClear()
    drawFocusLens(lens, page, annotations, unit, 1.25, true)
    expect(drawImage).not.toHaveBeenCalled()
  })
})
