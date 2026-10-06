import { describe, expect, it } from 'vitest'
import { buildPageReadingMap, findReadingUnitAt, type ReadingFragment } from './pdf-reading-map'

const fragment = (text: string, x: number, y: number, order: number, width = .08, height = .02): ReadingFragment => ({
  text, order, rect: { x, y, width, height }, leadingSpace: order > 0,
})

describe('PDF focus reading map', () => {
  it('groups fragments into lines and paragraphs in content order', () => {
    const map = buildPageReadingMap(3, [
      fragment('Dense', .1, .1, 0), fragment('paper.', .19, .1, 1),
      fragment('Second', .1, .13, 2), fragment('line.', .19, .13, 3),
      fragment('New', .1, .2, 4), fragment('paragraph.', .18, .2, 5),
    ])
    expect(map.units.line).toHaveLength(3)
    expect(map.units.paragraph).toHaveLength(2)
    expect(map.units.paragraph[0].rects).toHaveLength(2)
  })

  it('splits Unicode sentences and retains multiline geometry', () => {
    const map = buildPageReadingMap(1, [
      fragment('Émergence', .1, .1, 0), fragment('happens.', .25, .1, 1),
      fragment('¿Por', .1, .13, 2), fragment('qué?', .18, .13, 3),
    ])
    expect(map.units.sentence.map((unit) => unit.text)).toEqual(['Émergence happens.', '¿Por qué?'])
    expect(map.units.sentence[1].rects[0].y).toBeCloseTo(.13)
  })

  it('keeps punctuation and hyphenated line continuations deterministic', () => {
    const source = [
      fragment('Machine-', .1, .1, 0), fragment('learning', .1, .13, 1),
      fragment('works', .22, .13, 2), fragment('well', .31, .13, 3), fragment('!', .39, .13, 4, .01),
    ]
    const first = buildPageReadingMap(2, source)
    const second = buildPageReadingMap(2, source)
    expect(second).toEqual(first)
    expect(first.units.sentence[0].text).toContain('Machine- learning works well!')
  })

  it('ignores malformed fragments and hit-tests nearby units', () => {
    const map = buildPageReadingMap(1, [
      fragment('Readable', .1, .1, 0),
      { text: 'broken', order: 1, rect: { x: Number.NaN, y: 0, width: 1, height: 1 } },
    ])
    expect(map.units.line).toHaveLength(1)
    expect(findReadingUnitAt(map.units.line, .12, .11)?.text).toBe('Readable')
    expect(findReadingUnitAt(map.units.line, .9, .9)).toBeNull()
  })
})
