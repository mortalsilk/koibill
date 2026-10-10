import { beforeEach, describe, expect, it } from 'vitest'
import type { PdfSession } from '../../shared/types'
import { useWorkspaceStore } from './store'

const session = (documentId: string): PdfSession => ({
  id: `session-${documentId}`, documentId, name: `${documentId}.pdf`, fingerprint: documentId,
  bytes: new Uint8Array(), fingerprintMismatch: false,
  annotations: { schemaVersion: 2, sourceFingerprint: documentId, sourceFilename: `${documentId}.pdf`, modifiedAt: '', pages: [], annotations: [] },
})

describe('multi-document workspace store', () => {
  beforeEach(() => useWorkspaceStore.getState().restore({ schemaVersion: 1, documents: [], activeDocumentId: null, tray: [], question: '' }))

  it('keeps independent annotation and history state per PDF', () => {
    const state = useWorkspaceStore.getState()
    state.upsertSession(session('a')); state.upsertSession(session('b'))
    useWorkspaceStore.getState().addAnnotation('a', { id: 'mark', type: 'highlight', pageIndex: 0, rects: [], color: '#fff', opacity: .4, createdAt: '' })
    expect(useWorkspaceStore.getState().documents.a.document?.annotations).toHaveLength(1)
    expect(useWorkspaceStore.getState().documents.b.document?.annotations).toHaveLength(0)
    useWorkspaceStore.getState().undo('a')
    expect(useWorkspaceStore.getState().documents.a.document?.annotations).toHaveLength(0)
  })

  it('preserves tray excerpts when their PDF tab closes', () => {
    const state = useWorkspaceStore.getState(); state.upsertSession(session('a'))
    state.addTrayItem({ id: 'item', documentId: 'a', sourceFingerprint: 'a', documentName: 'a.pdf', pageNumber: 1, text: 'Excerpt', createdAt: '' })
    useWorkspaceStore.getState().close('a')
    expect(useWorkspaceStore.getState().tray[0].text).toBe('Excerpt')
  })

  it('clamps PDF zoom safely and keeps it independent per document', () => {
    const state = useWorkspaceStore.getState(); state.upsertSession(session('a')); state.upsertSession(session('b'))
    useWorkspaceStore.getState().setZoom('a', 9)
    useWorkspaceStore.getState().setZoom('b', 0.01)
    expect(useWorkspaceStore.getState().documents.a.zoom).toBe(4)
    expect(useWorkspaceStore.getState().documents.b.zoom).toBe(.25)
    useWorkspaceStore.getState().setZoom('a', 1.257)
    expect(useWorkspaceStore.getState().documents.a.zoom).toBe(1.26)
  })

  it('restores each document reading position', () => {
    useWorkspaceStore.getState().restore({
      schemaVersion: 1,
      documents: [{ documentId: 'a', name: 'a.pdf', missing: false, viewState: { zoom: 1.5, rotation: 270, currentPage: 8 } }],
      activeDocumentId: 'a', tray: [], question: '',
    })
    const restored = useWorkspaceStore.getState().documents.a
    expect({ zoom: restored.zoom, rotation: restored.rotation, currentPage: restored.currentPage }).toEqual({ zoom: 1.5, rotation: 270, currentPage: 8 })
  })

  it('restores and bounds per-document focus preferences', () => {
    useWorkspaceStore.getState().restore({
      schemaVersion: 1,
      documents: [{ documentId: 'a', name: 'a.pdf', missing: false, viewState: { zoom: 1, rotation: 0, currentPage: 2, focus: { enabled: true, unit: 'sentence', surroundingVisibility: .2 } } }],
      activeDocumentId: 'a', tray: [], question: '',
    })
    expect(useWorkspaceStore.getState().documents.a.focus).toEqual({ enabled: true, unit: 'sentence', surroundingVisibility: .2, magnification: 1.25 })
    useWorkspaceStore.getState().setFocus('a', { surroundingVisibility: .9, magnification: 3 })
    expect(useWorkspaceStore.getState().documents.a.focus.surroundingVisibility).toBe(.4)
    expect(useWorkspaceStore.getState().documents.a.focus.magnification).toBe(1.6)
  })

  it('tracks provider comparison progress and saved excerpts', () => {
    const comparison = {
      id: 'compare', title: 'Compare accounts', prompt: 'Prompt', promptEdited: false, contexts: [], linkTargets: [], excerpts: [],
      providers: [{ provider: 'chatgpt' as const, state: 'queued' as const }, { provider: 'claude' as const, state: 'queued' as const }], createdAt: 'now', modifiedAt: 'now',
    }
    useWorkspaceStore.getState().addComparison(comparison)
    useWorkspaceStore.getState().updateComparisonProvider('compare', 'claude', 'inserted', 'Inserted')
    useWorkspaceStore.getState().addComparisonExcerpt('compare', { id: 'excerpt', provider: 'claude', text: 'Answer fragment', title: 'Claude', createdAt: 'now' })
    const stored = useWorkspaceStore.getState().comparisons[0]
    expect(stored.providers[1]).toMatchObject({ provider: 'claude', state: 'inserted', message: 'Inserted' })
    expect(stored.excerpts[0].text).toBe('Answer fragment')
  })
})
