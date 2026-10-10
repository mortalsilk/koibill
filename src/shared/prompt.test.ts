import { describe, expect, it } from 'vitest'
import { formatContextPrompt, formatPrompt } from './prompt'

describe('formatPrompt', () => {
  it('includes source context and quotes every selected line', () => {
    expect(formatPrompt({
      kind: 'selection', provider: 'chatgpt', requestId: 'request-1', linkTargets: [],
      text: 'First line\nSecond line',
      documentName: 'notes.pdf',
      pageNumber: 7,
      mode: 'draft',
    })).toBe("I'm reading “notes.pdf”, page 7. Please help me understand this passage:\n\n> First line\n> Second line")
  })

  it('formats a numbered cross-document research prompt', () => {
    expect(formatPrompt({
      kind: 'research', provider: 'chatgpt', requestId: 'request-2', linkTargets: [], mode: 'draft', question: '',
      items: [
        { id: '1', documentId: 'a', sourceFingerprint: 'fa', documentName: 'a.pdf', pageNumber: 2, text: 'Alpha', createdAt: '' },
        { id: '2', documentId: 'b', sourceFingerprint: 'fb', documentName: 'b.pdf', pageNumber: 9, text: 'Beta', createdAt: '' },
      ],
    })).toContain('[2] “b.pdf”, page 9\n> Beta')
  })

  it('preserves a cross-page semantic selection citation', () => {
    expect(formatPrompt({
      kind: 'selection', provider: 'claude', requestId: 'range', linkTargets: [], mode: 'draft',
      text: 'A passage across a page break', documentName: 'paper.pdf', pageNumber: 4, endPageNumber: 5,
    })).toContain('“paper.pdf”, pages 4–5')
  })

  it('formats only enabled composer context with source citations', () => {
    const prompt = formatContextPrompt('Challenge this claim.', [
      { id: 'selection', kind: 'selection', label: 'Selected passage', text: 'Primary claim', enabled: true, documentName: 'systems.pdf', pageNumber: 8 },
      { id: 'nearby', kind: 'nearby', label: 'Surrounding text', text: 'Hidden context', enabled: false, documentName: 'systems.pdf', pageNumber: 8 },
      { id: 'note', kind: 'page-note', label: 'Page note', text: 'My note', enabled: true, documentName: 'systems.pdf', pageNumber: 8 },
    ])
    expect(prompt).toContain('Challenge this claim.')
    expect(prompt).toContain('[1] Selected passage — “systems.pdf”, page 8')
    expect(prompt).toContain('[2] Page note — “systems.pdf”, page 8')
    expect(prompt).not.toContain('Hidden context')
  })

  it('treats a composed prompt as authoritative', () => {
    expect(formatPrompt({ kind: 'composed', provider: 'gemini', requestId: 'composed', linkTargets: [], mode: 'send', prompt: 'Edited by the reader', contexts: [], promptEdited: true })).toBe('Edited by the reader')
  })
})
