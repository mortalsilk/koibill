export interface PdfSelectionPageRange {
  start: number
  end: number
}

export function getPdfSelectionPageRange(
  selection: Selection | null,
  viewer: HTMLElement | null,
): PdfSelectionPageRange | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !viewer) return null

  const anchorPage = pageNumberForNode(selection.anchorNode, viewer)
  const focusPage = pageNumberForNode(selection.focusNode, viewer)
  if (anchorPage === null || focusPage === null) return null

  return {
    start: Math.min(anchorPage, focusPage),
    end: Math.max(anchorPage, focusPage),
  }
}

export function shouldRenderPdfPage(
  pageNumber: number,
  currentPage: number,
  zoom: number,
  selectionRange: PdfSelectionPageRange | null,
): boolean {
  const renderRadius = zoom <= 0.5 ? 3 : zoom <= 1 ? 2 : 1
  const nearViewport = Math.abs(pageNumber - currentPage) <= renderRadius
  const holdsSelection = selectionRange !== null
    && pageNumber >= selectionRange.start
    && pageNumber <= selectionRange.end
  return nearViewport || holdsSelection
}

function pageNumberForNode(node: Node | null, viewer: HTMLElement): number | null {
  const element = node instanceof Element ? node : node?.parentElement
  const page = element?.closest<HTMLElement>('.pdf-page')
  if (!page || !viewer.contains(page)) return null
  const pageNumber = Number(page.dataset.pageNumber)
  return Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : null
}
