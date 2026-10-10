import { describe, expect, it } from 'vitest'
import { isAIComparisonRecord, isAskAIComparisonRequest, isAskAIRequest, isChatGptAuthCompletion, isChatGptConversationUrl, isGraphDocument, isSafeWebUrl, isWorkspaceUiState, migrateAnnotationDocument, normalizeNavigation } from './validation'

describe('web navigation validation', () => {
  it('allows HTTPS and the controlled blank page', () => {
    expect(isSafeWebUrl('https://chatgpt.com/')).toBe(true)
    expect(isSafeWebUrl('about:blank')).toBe(true)
  })

  it('rejects executable and insecure protocols', () => {
    expect(isSafeWebUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeWebUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeWebUrl('http://example.com')).toBe(false)
  })

  it('normalizes domains and search queries', () => {
    expect(normalizeNavigation('example.com')).toBe('https://example.com')
    expect(normalizeNavigation('explain quantum dots')).toBe('https://www.google.com/search?q=explain%20quantum%20dots')
  })
})

describe('ChatGPT authentication navigation', () => {
  it('detects the transition from authentication to the signed-in app', () => {
    expect(isChatGptAuthCompletion('https://chatgpt.com/auth/login', 'https://chatgpt.com/')).toBe(true)
    expect(isChatGptAuthCompletion('https://chatgpt.com/', 'https://chatgpt.com/c/123')).toBe(false)
    expect(isChatGptAuthCompletion('https://example.com/auth/login', 'https://chatgpt.com/')).toBe(false)
  })
})

describe('Ask AI validation', () => {
  it('accepts a bounded passage', () => {
    expect(isAskAIRequest({ kind: 'selection', provider: 'claude', requestId: '1', linkTargets: [], text: 'hello', documentName: 'paper.pdf', pageNumber: 2, mode: 'draft' })).toBe(true)
  })

  it('rejects oversized passages and unknown modes', () => {
    expect(isAskAIRequest({ kind: 'selection', provider: 'gemini', requestId: '1', linkTargets: [], text: 'x'.repeat(20_001), documentName: 'paper.pdf', pageNumber: 1, mode: 'draft' })).toBe(false)
    expect(isAskAIRequest({ kind: 'selection', provider: 'unknown', requestId: '1', linkTargets: [], text: 'hello', documentName: 'paper.pdf', pageNumber: 1, mode: 'draft' })).toBe(false)
    expect(isAskAIRequest({ kind: 'selection', provider: 'chatgpt', requestId: '1', linkTargets: [], text: 'hello', documentName: 'paper.pdf', pageNumber: 1, mode: 'delete' })).toBe(false)
  })

  it('validates composed and multi-provider requests strictly', () => {
    const context = { id: 'source', kind: 'selection', label: 'Passage', text: 'hello', enabled: true }
    expect(isAskAIRequest({ kind: 'composed', provider: 'perplexity', requestId: '1', linkTargets: [], mode: 'send', prompt: 'Review this', contexts: [context], promptEdited: false })).toBe(true)
    const comparison = { requestId: 'request', comparisonId: 'comparison', providers: ['chatgpt', 'claude'], prompt: 'Review this', contexts: [context], promptEdited: false, linkTargets: [] }
    expect(isAskAIComparisonRequest(comparison)).toBe(true)
    expect(isAskAIComparisonRequest({ ...comparison, providers: ['chatgpt', 'chatgpt'] })).toBe(false)
    expect(isAskAIComparisonRequest({ ...comparison, providers: ['chatgpt'] })).toBe(false)
  })

  it('keeps comparison links bound to their provider', () => {
    const base = {
      id: 'comparison', title: 'Compare', prompt: 'Prompt', promptEdited: false, contexts: [], linkTargets: [], excerpts: [], createdAt: 'now', modifiedAt: 'now',
      providers: [{ provider: 'chatgpt', state: 'inserted' }, { provider: 'claude', state: 'linked', conversationLink: { id: 'link', provider: 'claude', url: 'https://claude.ai/chat/abc', title: 'Chat', createdAt: 'now' } }],
    }
    expect(isAIComparisonRecord(base)).toBe(true)
    expect(isAIComparisonRecord({ ...base, providers: [base.providers[0], { ...base.providers[1], provider: 'gemini' }] })).toBe(false)
  })
})

describe('annotation migration and conversation links', () => {
  it('migrates a version-one sidecar without losing annotations', () => {
    const migrated = migrateAnnotationDocument({ schemaVersion: 1, sourceFingerprint: 'fp', sourceFilename: 'a.pdf', modifiedAt: 'now', pages: [], annotations: [{ id: 'a', type: 'highlight', pageIndex: 0, rects: [], color: '#fff', opacity: .4, createdAt: 'now' }] })
    expect(migrated?.schemaVersion).toBe(2)
    expect(migrated?.annotations[0].id).toBe('a')
  })

  it('accepts only ChatGPT conversation URLs', () => {
    expect(isChatGptConversationUrl('https://chatgpt.com/c/abc')).toBe(true)
    expect(isChatGptConversationUrl('https://chatgpt.com/')).toBe(false)
    expect(isChatGptConversationUrl('https://example.com/c/abc')).toBe(false)
  })

  it('infers ChatGPT for legacy conversation links', () => {
    const migrated = migrateAnnotationDocument({ schemaVersion: 2, sourceFingerprint: 'fp', sourceFilename: 'a.pdf', modifiedAt: 'now', pages: [], annotations: [{ id: 'a', type: 'highlight', pageIndex: 0, rects: [], color: '#fff', opacity: .4, createdAt: 'now', conversationLinks: [{ id: 'link', url: 'https://chatgpt.com/c/abc', title: 'Chat', createdAt: 'now' }] }] })
    expect(migrated?.annotations[0].conversationLinks?.[0].provider).toBe('chatgpt')
  })
})

describe('workspace reading state validation', () => {
  it('requires a bounded reading state for every open PDF', () => {
    const base = { documentIds: ['a'], activeDocumentId: 'a', tray: [], question: '' }
    expect(isWorkspaceUiState({ ...base, viewStates: { a: { zoom: 1.5, rotation: 90, currentPage: 3 } } })).toBe(true)
    expect(isWorkspaceUiState({ ...base, viewStates: { a: { zoom: 1.5, rotation: 90, currentPage: 3, focus: { enabled: true, unit: 'sentence', surroundingVisibility: .15 } } } })).toBe(true)
    expect(isWorkspaceUiState({ ...base, viewStates: { a: { zoom: 1.5, rotation: 90, currentPage: 3, focus: { enabled: true, unit: 'sentence', surroundingVisibility: .15, magnification: 1.4 } } } })).toBe(true)
    expect(isWorkspaceUiState({ ...base, viewStates: { a: { zoom: 1.5, rotation: 90, currentPage: 3, reflow: { mode: 'split', splitRatio: .55 } } } })).toBe(true)
    expect(isWorkspaceUiState({ ...base, viewStates: { a: { zoom: 1.5, rotation: 90, currentPage: 3, reflow: { mode: 'unknown', splitRatio: .55 } } } })).toBe(false)
    expect(isWorkspaceUiState({ ...base, viewStates: { a: { zoom: 1.5, rotation: 90, currentPage: 3, focus: { enabled: true, unit: 'column', surroundingVisibility: .15 } } } })).toBe(false)
    expect(isWorkspaceUiState({ ...base, viewStates: { a: { zoom: 1.5, rotation: 90, currentPage: 3, focus: { enabled: true, unit: 'line', surroundingVisibility: .8 } } } })).toBe(false)
    expect(isWorkspaceUiState({ ...base, viewStates: { a: { zoom: 1.5, rotation: 90, currentPage: 3, focus: { enabled: true, unit: 'line', surroundingVisibility: .15, magnification: 2 } } } })).toBe(false)
    expect(isWorkspaceUiState({ ...base, viewStates: {} })).toBe(false)
    expect(isWorkspaceUiState({ ...base, viewStates: { a: { zoom: 9, rotation: 45, currentPage: 0 } } })).toBe(false)
  })
})

describe('graph document validation', () => {
  const graph = {
    schemaVersion: 1, sourceFingerprint: 'fp', sourceFilename: 'book.pdf', modifiedAt: 'now', viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{
      id: 'idea-1', position: { x: 10, y: 20 }, title: 'Idea', userText: 'My synthesis', createdAt: 'now', modifiedAt: 'now',
      sources: [{ id: 'source-1', kind: 'chatgpt', excerpt: 'An LLM observation', pageNumber: 4, url: 'https://chatgpt.com/c/abc', createdAt: 'now' }],
    }],
    edges: [],
  }

  it('accepts a bounded source-aware graph', () => expect(isGraphDocument(graph)).toBe(true))
  it('rejects dangling edges and unsafe source URLs', () => {
    expect(isGraphDocument({ ...graph, edges: [{ id: 'e', source: 'idea-1', target: 'missing', createdAt: 'now' }] })).toBe(false)
    expect(isGraphDocument({ ...graph, nodes: [{ ...graph.nodes[0], sources: [{ ...graph.nodes[0].sources[0], url: 'file:///etc/passwd' }] }] })).toBe(false)
  })
})
