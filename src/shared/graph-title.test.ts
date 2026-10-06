import { describe, expect, it } from 'vitest'
import { cleanText, extractKeywordTitle, generateGraphNodeTitle } from './graph-title'

describe('offline graph keyword titles', () => {
  it('extracts a repeated meaningful phrase deterministically', () => {
    const excerpt = 'The chapter introduces neural plasticity in the developing brain. Neural plasticity supports adaptive learning. Neural plasticity also enables recovery.'
    const first = extractKeywordTitle(excerpt)
    expect(first).toMatch(/neural plasticity/iu)
    expect(extractKeywordTitle(excerpt)).toBe(first)
    expect(first!.length).toBeLessThanOrEqual(80)
  })

  it.each([
    'La memoria de trabajo permite organizar información compleja durante el razonamiento.',
    'La mémoire de travail organise les informations complexes pendant le raisonnement.',
    'Das Arbeitsgedächtnis verarbeitet komplexe Informationen während des Lernens.',
    'A memória de trabalho organiza informações complexas durante o raciocínio.',
    'La memoria di lavoro organizza informazioni complesse durante il ragionamento.',
    '概念ネットワークは複雑な議論の構造を視覚的に整理します。',
  ])('handles multilingual Unicode text: %s', (excerpt) => {
    const title = extractKeywordTitle(excerpt)
    expect(title).toBeTruthy()
    expect(title!.length).toBeLessThanOrEqual(80)
    for (const word of title!.match(/[\p{L}\p{N}]+/gu) ?? []) expect(excerpt).toContain(word)
  })

  it('removes Markdown, citations, and URLs before scoring', () => {
    const excerpt = '**Distributed cognition** links tools and social interaction [12]. Read https://example.com/details for more.'
    const title = extractKeywordTitle(excerpt)
    expect(title).toMatch(/Distributed cognition/iu)
    expect(title).not.toMatch(/https|\[12\]|\*\*/u)
    expect(cleanText('[Useful label](https://example.com)')).toBe('Useful label')
  })

  it('handles short and repeated excerpts without inventing words', () => {
    expect(extractKeywordTitle('Photosynthesis.')).toBe('Photosynthesis')
    const excerpt = 'Evidence evidence evidence supports careful comparison.'
    const title = extractKeywordTitle(excerpt)!
    const sourceWords = new Set(excerpt.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu))
    for (const word of title.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) expect(sourceWords.has(word)).toBe(true)
  })

  it('uses the Unicode regex tokenizer when Intl.Segmenter is unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')
    Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined })
    try { expect(extractKeywordTitle('Analyse déterministe des réseaux conceptuels.')).toMatch(/Analyse|déterministe|réseaux|conceptuels/u) }
    finally { if (descriptor) Object.defineProperty(Intl, 'Segmenter', descriptor) }
  })

  it('uses source-specific fallbacks for stop-word-only excerpts', () => {
    expect(generateGraphNodeTitle({ kind: 'web', excerpt: 'the and of', pageNumber: 1, title: 'A Useful Web Page' })).toBe('A Useful Web Page')
    expect(generateGraphNodeTitle({ kind: 'pdf', excerpt: 'the and of', pageNumber: 9 })).toBe('Idea from page 9')
    expect(generateGraphNodeTitle({ kind: 'chatgpt', excerpt: 'the and of', pageNumber: 2 })).toBe('ChatGPT insight')
  })

  it('bounds long titles without cutting through a word', () => {
    const excerpt = 'Hyperconnectivity '.repeat(20)
    const title = extractKeywordTitle(excerpt)!
    expect(title.length).toBeLessThanOrEqual(80)
    expect(title.endsWith('Hyperconnectivity')).toBe(true)
  })
})
