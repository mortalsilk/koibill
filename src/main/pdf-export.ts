import path from 'node:path'
import { promises as fs } from 'node:fs'
import { dialog } from 'electron'
import { PDFDocument, rgb } from 'pdf-lib'
import type { AnnotationDocument } from '../shared/types'
import type { PdfSessionManager } from './storage'

const colors: Record<string, [number, number, number]> = {
  '#000000': [0, 0, 0],
  '#ef4444': [0.937, 0.267, 0.267],
  '#2563eb': [0.145, 0.388, 0.922],
  '#16a34a': [0.086, 0.639, 0.29],
  '#fde047': [0.992, 0.878, 0.278],
  '#facc15': [0.98, 0.8, 0.08],
  '#4ade80': [0.29, 0.87, 0.5],
  '#60a5fa': [0.38, 0.65, 0.98],
  '#f472b6': [0.96, 0.45, 0.71],
  '#fb923c': [0.98, 0.57, 0.24],
}

export async function exportAnnotatedPdf(
  sessions: PdfSessionManager,
  sessionId: string,
  document: AnnotationDocument,
): Promise<{ exported: boolean; pathLabel?: string }> {
  const session = sessions.getSession(sessionId)
  let pdf: PDFDocument
  try {
    pdf = await PDFDocument.load(session.bytes)
  } catch {
    throw new Error('Encrypted or unsupported PDFs cannot be exported in this version.')
  }

  const pages = pdf.getPages()
  for (const annotation of document.annotations) {
    const page = pages[annotation.pageIndex]
    if (!page) continue
    // PDF.js normalizes annotation coordinates against the visible page box,
    // which corresponds to the crop box when one exists.
    const box = page.getCropBox()
    const [red, green, blue] = colors[annotation.color.toLowerCase()] ?? [0, 0, 0]
    const color = rgb(red, green, blue)

    if (annotation.type === 'highlight') {
      for (const rect of annotation.rects) {
        page.drawRectangle({
          x: box.x + rect.x * box.width,
          y: box.y + rect.y * box.height,
          width: rect.width * box.width,
          height: rect.height * box.height,
          color,
          opacity: annotation.opacity,
          borderWidth: 0,
        })
      }
    } else {
      for (let index = 1; index < annotation.points.length; index += 1) {
        const start = annotation.points[index - 1]
        const end = annotation.points[index]
        page.drawLine({
          start: { x: box.x + start.x * box.width, y: box.y + start.y * box.height },
          end: { x: box.x + end.x * box.width, y: box.y + end.y * box.height },
          thickness: annotation.width,
          color,
          opacity: annotation.opacity,
        })
      }
    }
  }

  const result = await dialog.showSaveDialog({
    title: 'Export annotated PDF',
    defaultPath: path.join(path.dirname(session.path), `${path.basename(session.path, '.pdf')}-annotated.pdf`),
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
  })
  if (result.canceled || !result.filePath) return { exported: false }
  if (path.resolve(result.filePath) === path.resolve(session.path)) {
    throw new Error('Choose a new filename. koibill never overwrites the source PDF.')
  }
  await fs.writeFile(result.filePath, await pdf.save())
  return { exported: true, pathLabel: path.basename(result.filePath) }
}
