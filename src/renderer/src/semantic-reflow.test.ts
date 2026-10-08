import { describe, expect, it } from 'vitest'
import { createSemanticDocument, extractSemanticPage, removeRecurringPageFurniture, replaceSemanticPage, semanticCacheMatches, type SemanticTextItem } from './semantic-reflow'

function item(text: string, x: number, y: number, width = .35, height = .025, fontSize = 10, role?: string): SemanticTextItem {
  return { text, rect: { x, y, width, height }, fontSize, role }
}

describe('semantic reflow extraction', () => {
  it('groups nearby lines into a paragraph and preserves source geometry', () => {
    const blocks = extractSemanticPage(3, [item('First line', .1, .2), item('continues here.', .1, .235)])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'paragraph', text: 'First line continues here.' })
    expect(blocks[0].sourceSpans[0]).toMatchObject({ pageNumber: 3, start: 0, end: 26 })
    expect(blocks[0].sourceSpans[0].rects.length).toBeGreaterThan(0)
  })

  it('uses tagged roles ahead of typography heuristics', () => {
    const blocks = extractSemanticPage(1, [item('Methodology', .1, .2, .4, .025, 10, 'H2'), item('Body text.', .1, .27, .4, .025, 10, 'P')])
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 2, confidence: .96 })
    expect(blocks[1].type).toBe('paragraph')
  })

  it('classifies large untagged text as a heading', () => {
    const blocks = extractSemanticPage(1, [item('Results', .1, .18, .3, .035, 18), item('Measurements follow.', .1, .29, .5, .025, 10)])
    expect(blocks[0].type).toMatch(/title|heading/u)
  })

  it('orders two-column content by column', () => {
    const blocks = extractSemanticPage(2, [
      item('Left one.', .08, .2, .34), item('Left two.', .08, .35, .34), item('Left three.', .08, .5, .34),
      item('Right one.', .56, .2, .34), item('Right two.', .56, .35, .34), item('Right three.', .56, .5, .34),
    ])
    expect(blocks.map((block) => block.text)).toEqual(['Left one.', 'Left two.', 'Left three.', 'Right one.', 'Right two.', 'Right three.'])
  })

  it('conservatively joins a lowercase hyphenated continuation', () => {
    const blocks = extractSemanticPage(1, [item('inter-', .1, .2), item('operability matters.', .1, .235)])
    expect(blocks[0].text).toBe('interoperability matters.')
  })

  it('creates a source crop for a reliably recognized figure caption', () => {
    const blocks = extractSemanticPage(4, [item('Figure 2. System architecture', .12, .7, .7, .025, 9, 'Caption')])
    expect(blocks.map((block) => block.type)).toEqual(['figure', 'caption'])
    expect(blocks[0].asset).toMatchObject({ pageNumber: 4, kind: 'figure' })
  })

  it('keeps Unicode text and normalized rectangles intact', () => {
    const blocks = extractSemanticPage(1, [item('Δεδομένα — naïve 日本語', .2, .3, .5)])
    expect(blocks[0].text).toBe('Δεδομένα — naïve 日本語')
    expect(blocks[0].sourceSpans[0].rects[0].x).toBeCloseTo(.2)
    expect(blocks[0].sourceSpans[0].rects[0].y).toBeCloseTo(.3)
    expect(blocks[0].sourceSpans[0].rects[0].width).toBeCloseTo(.5)
    expect(blocks[0].sourceSpans[0].rects[0].height).toBeCloseTo(.025)
  })

  it('invalidates caches by fingerprint, page count, and extractor version', () => {
    const document = createSemanticDocument('abc', 'paper.pdf', 10)
    expect(semanticCacheMatches(document, 'abc', 10)).toBe(true)
    expect(semanticCacheMatches(document, 'changed', 10)).toBe(false)
    expect(semanticCacheMatches({ ...document, extractorVersion: 'old' }, 'abc', 10)).toBe(false)
  })

  it('removes repeated running headers after extraction completes', () => {
    let document = createSemanticDocument('abc', 'paper.pdf', 10)
    for (let page = 1; page <= 3; page += 1) {
      document = replaceSemanticPage(document, page, extractSemanticPage(page, [item('Journal of Systems 2026', .1, .04, .6), item(`Page body ${page}.`, .1, .3, .6)]))
    }
    const cleaned = removeRecurringPageFurniture(document)
    expect(cleaned.blocks.some((block) => block.text.startsWith('Journal of Systems'))).toBe(false)
    expect(cleaned.blocks.filter((block) => block.text.startsWith('Page body'))).toHaveLength(3)
  })
})
