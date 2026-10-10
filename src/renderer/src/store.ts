import { create } from 'zustand'
import type {
  AIComparisonExcerpt, AIComparisonRecord, AIProviderId, Annotation, AnnotationConversationLink, AnnotationDocument, AskAIProviderDeliveryState, PageMetadata, PdfSession,
  PdfFocusSettings, PdfTabDescriptor, ResearchTrayItem, ResearchWorkspace, ToolMode,
  ReflowViewSettings,
} from '../../shared/types'

export interface PdfDocumentState {
  descriptor: PdfTabDescriptor
  session?: PdfSession
  document?: AnnotationDocument
  past: Annotation[][]
  future: Annotation[][]
  zoom: number
  rotation: number
  currentPage: number
  focus: PdfFocusSettings
  reflow: ReflowViewSettings
  status: 'idle' | 'loading' | 'ready' | 'missing' | 'error'
  error?: string
  fingerprintMismatch: boolean
}

interface WorkspaceState {
  documents: Record<string, PdfDocumentState>
  order: string[]
  activeDocumentId: string | null
  tray: ResearchTrayItem[]
  question: string
  comparisons: AIComparisonRecord[]
  tool: ToolMode
  highlightColor: string
  penColor: string
  penWidth: number
  selectedAnnotationId: string | null
  restore: (workspace: ResearchWorkspace) => void
  upsertSession: (session: PdfSession) => void
  setDocumentStatus: (documentId: string, status: PdfDocumentState['status'], error?: string) => void
  activate: (documentId: string) => void
  close: (documentId: string) => void
  move: (documentId: string, direction: -1 | 1) => void
  addAnnotation: (documentId: string, annotation: Annotation) => void
  removeAnnotation: (documentId: string, annotationId: string) => void
  updateAnnotationNote: (documentId: string, annotationId: string, note: string) => void
  addConversationLink: (documentId: string, annotationId: string, link: AnnotationConversationLink) => void
  removeConversationLink: (documentId: string, annotationId: string, linkId: string) => void
  setPageMetadata: (documentId: string, pages: PageMetadata[]) => void
  clearAnnotations: (documentId: string) => void
  acceptSourceFingerprint: (documentId: string) => void
  undo: (documentId: string) => void
  redo: (documentId: string) => void
  setTool: (tool: ToolMode) => void
  setHighlightColor: (color: string) => void
  setPenColor: (color: string) => void
  setPenWidth: (width: number) => void
  setZoom: (documentId: string, zoom: number) => void
  setRotation: (documentId: string, rotation: number) => void
  setCurrentPage: (documentId: string, page: number) => void
  setFocus: (documentId: string, focus: Partial<PdfFocusSettings>) => void
  setReflow: (documentId: string, reflow: Partial<ReflowViewSettings>) => void
  selectAnnotation: (annotationId: string | null) => void
  addTrayItem: (item: ResearchTrayItem) => void
  removeTrayItem: (id: string) => void
  moveTrayItem: (id: string, direction: -1 | 1) => void
  clearTray: () => void
  setQuestion: (question: string) => void
  addComparison: (comparison: AIComparisonRecord) => void
  updateComparisonProvider: (id: string, provider: AIProviderId, state: AskAIProviderDeliveryState, message?: string, link?: AnnotationConversationLink) => void
  addComparisonExcerpt: (id: string, excerpt: AIComparisonExcerpt) => void
  renameComparison: (id: string, title: string) => void
  removeComparisonExcerpt: (id: string, excerptId: string) => void
  removeComparison: (id: string) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  documents: {}, order: [], activeDocumentId: null, tray: [], question: '', comparisons: [],
  tool: 'select', highlightColor: '#facc15', penColor: '#000000', penWidth: 2,
  selectedAnnotationId: null,
  restore: (workspace) => set({
    documents: Object.fromEntries(workspace.documents.map((descriptor) => [descriptor.documentId, emptyTab(descriptor)])),
    order: workspace.documents.map((descriptor) => descriptor.documentId),
    activeDocumentId: workspace.activeDocumentId,
    tray: workspace.tray,
    question: workspace.question,
    comparisons: workspace.comparisons ?? [],
    selectedAnnotationId: null,
  }),
  upsertSession: (session) => set((state) => {
    const existing = state.documents[session.documentId]
    const descriptor: PdfTabDescriptor = { documentId: session.documentId, name: session.name, fingerprint: session.fingerprint, missing: false, viewState: session.viewState }
    const portableItems = (session.researchItems ?? []).filter((item) => !state.tray.some((existing) => existing.id === item.id))
    return {
      documents: {
        ...state.documents,
        [session.documentId]: {
          ...(existing ?? emptyTab(descriptor)), descriptor, session, document: session.annotations,
          status: 'ready', error: undefined, fingerprintMismatch: session.fingerprintMismatch,
        },
      },
      order: state.order.includes(session.documentId) ? state.order : [...state.order, session.documentId],
      activeDocumentId: session.documentId,
      tray: [...state.tray, ...portableItems],
    }
  }),
  setDocumentStatus: (documentId, status, error) => set((state) => updateTab(state, documentId, (tab) => ({ ...tab, status, error }))),
  activate: (activeDocumentId) => set({ activeDocumentId, selectedAnnotationId: null }),
  close: (documentId) => set((state) => {
    const order = state.order.filter((id) => id !== documentId)
    const documents = { ...state.documents }; delete documents[documentId]
    const oldIndex = state.order.indexOf(documentId)
    return {
      documents, order,
      activeDocumentId: state.activeDocumentId === documentId ? order[Math.min(Math.max(oldIndex, 0), order.length - 1)] ?? null : state.activeDocumentId,
      selectedAnnotationId: null,
    }
  }),
  move: (documentId, direction) => set((state) => {
    const index = state.order.indexOf(documentId); const target = index + direction
    if (index < 0 || target < 0 || target >= state.order.length) return state
    const order = [...state.order]; order.splice(index, 1); order.splice(target, 0, documentId)
    return { order }
  }),
  addAnnotation: (documentId, annotation) => set((state) => mutateAnnotations(state, documentId, (items) => [...items, annotation])),
  removeAnnotation: (documentId, annotationId) => set((state) => mutateAnnotations(state, documentId, (items) => items.filter((item) => item.id !== annotationId))),
  updateAnnotationNote: (documentId, annotationId, note) => set((state) => mutateAnnotations(state, documentId, (items) => items.map((item) => item.id === annotationId ? { ...item, note: note || undefined } : item))),
  addConversationLink: (documentId, annotationId, link) => set((state) => mutateAnnotations(state, documentId, (items) => items.map((item) => item.id === annotationId ? {
    ...item,
    conversationLinks: [...(item.conversationLinks ?? []).filter((existing) => existing.url !== link.url), link],
  } : item))),
  removeConversationLink: (documentId, annotationId, linkId) => set((state) => mutateAnnotations(state, documentId, (items) => items.map((item) => item.id === annotationId ? {
    ...item, conversationLinks: (item.conversationLinks ?? []).filter((link) => link.id !== linkId),
  } : item))),
  setPageMetadata: (documentId, pages) => set((state) => updateDocument(state, documentId, (document) => ({ ...document, pages }))),
  clearAnnotations: (documentId) => set((state) => {
    const tab = state.documents[documentId]; if (!tab?.document) return state
    return updateTab(state, documentId, (current) => ({
      ...current,
      document: { ...current.document!, sourceFingerprint: current.session?.fingerprint ?? current.document!.sourceFingerprint, annotations: [], modifiedAt: now() },
      past: [...current.past, current.document!.annotations], future: [], fingerprintMismatch: false,
    }))
  }),
  acceptSourceFingerprint: (documentId) => set((state) => updateTab(state, documentId, (tab) => !tab.document || !tab.session ? tab : ({
    ...tab, document: { ...tab.document, sourceFingerprint: tab.session.fingerprint, sourceFilename: tab.session.name, modifiedAt: now() }, fingerprintMismatch: false,
  }))),
  undo: (documentId) => set((state) => updateTab(state, documentId, (tab) => {
    if (!tab.document || !tab.past.length) return tab
    const previous = tab.past[tab.past.length - 1]
    return { ...tab, document: { ...tab.document, annotations: previous, modifiedAt: now() }, past: tab.past.slice(0, -1), future: [tab.document.annotations, ...tab.future] }
  })),
  redo: (documentId) => set((state) => updateTab(state, documentId, (tab) => {
    if (!tab.document || !tab.future.length) return tab
    const next = tab.future[0]
    return { ...tab, document: { ...tab.document, annotations: next, modifiedAt: now() }, past: [...tab.past, tab.document.annotations], future: tab.future.slice(1) }
  })),
  setTool: (tool) => set({ tool }), setHighlightColor: (highlightColor) => set({ highlightColor }),
  setPenColor: (penColor) => set({ penColor }), setPenWidth: (penWidth) => set({ penWidth }),
  setZoom: (documentId, zoom) => set((state) => updateTab(state, documentId, (tab) => ({ ...tab, zoom: Math.min(4, Math.max(0.25, Math.round(zoom * 100) / 100)) }))),
  setRotation: (documentId, rotation) => set((state) => updateTab(state, documentId, (tab) => ({ ...tab, rotation: ((rotation % 360) + 360) % 360 }))),
  setCurrentPage: (documentId, currentPage) => set((state) => updateTab(state, documentId, (tab) => tab.currentPage === currentPage ? tab : ({ ...tab, currentPage }))),
  setFocus: (documentId, focus) => set((state) => updateTab(state, documentId, (tab) => ({
    ...tab,
    focus: {
      ...tab.focus,
      ...focus,
      surroundingVisibility: Math.min(.4, Math.max(.05, focus.surroundingVisibility ?? tab.focus.surroundingVisibility)),
      magnification: Math.min(1.6, Math.max(1.1, focus.magnification ?? tab.focus.magnification ?? 1.25)),
    },
  }))),
  setReflow: (documentId, reflow) => set((state) => updateTab(state, documentId, (tab) => ({
    ...tab,
    reflow: {
      ...tab.reflow,
      ...reflow,
      splitRatio: Math.min(.75, Math.max(.25, reflow.splitRatio ?? tab.reflow.splitRatio)),
    },
  }))),
  selectAnnotation: (selectedAnnotationId) => set({ selectedAnnotationId }),
  addTrayItem: (item) => set((state) => ({ tray: state.tray.some((existing) => existing.id === item.id) ? state.tray : [...state.tray, item] })),
  removeTrayItem: (id) => set((state) => ({ tray: state.tray.filter((item) => item.id !== id) })),
  moveTrayItem: (id, direction) => set((state) => {
    const index = state.tray.findIndex((item) => item.id === id); const target = index + direction
    if (index < 0 || target < 0 || target >= state.tray.length) return state
    const tray = [...state.tray]; const [item] = tray.splice(index, 1); tray.splice(target, 0, item); return { tray }
  }),
  clearTray: () => set({ tray: [] }), setQuestion: (question) => set({ question }),
  addComparison: (comparison) => set((state) => ({ comparisons: [comparison, ...state.comparisons].slice(0, 100) })),
  updateComparisonProvider: (id, provider, status, message, link) => set((state) => ({ comparisons: state.comparisons.map((comparison) => comparison.id === id ? {
    ...comparison, modifiedAt: now(), providers: comparison.providers.map((item) => item.provider === provider ? { ...item, state: status, message, conversationLink: link ?? item.conversationLink } : item),
  } : comparison) })),
  addComparisonExcerpt: (id, excerpt) => set((state) => ({ comparisons: state.comparisons.map((comparison) => comparison.id === id ? { ...comparison, modifiedAt: now(), excerpts: [...comparison.excerpts, excerpt].slice(-100) } : comparison) })),
  renameComparison: (id, title) => set((state) => ({ comparisons: state.comparisons.map((item) => item.id === id ? { ...item, title: title.slice(0, 200), modifiedAt: now() } : item) })),
  removeComparisonExcerpt: (id, excerptId) => set((state) => ({ comparisons: state.comparisons.map((item) => item.id === id ? { ...item, excerpts: item.excerpts.filter((excerpt) => excerpt.id !== excerptId), modifiedAt: now() } : item) })),
  removeComparison: (id) => set((state) => ({ comparisons: state.comparisons.filter((item) => item.id !== id) })),
}))

function emptyTab(descriptor: PdfTabDescriptor): PdfDocumentState {
  return {
    descriptor, past: [], future: [],
    zoom: descriptor.viewState?.zoom ?? 1,
    rotation: descriptor.viewState?.rotation ?? 0,
    currentPage: descriptor.viewState?.currentPage ?? 1,
    focus: descriptor.viewState?.focus
      ? { ...descriptor.viewState.focus, magnification: descriptor.viewState.focus.magnification ?? 1.25 }
      : { enabled: false, unit: 'paragraph', surroundingVisibility: .15, magnification: 1.25 },
    reflow: descriptor.viewState?.reflow ?? { mode: 'original', splitRatio: .5 },
    status: descriptor.missing ? 'missing' : 'idle', fingerprintMismatch: false,
  }
}

function updateTab(state: WorkspaceState, id: string, update: (tab: PdfDocumentState) => PdfDocumentState): Partial<WorkspaceState> {
  const tab = state.documents[id]; if (!tab) return state
  const next = update(tab)
  return next === tab ? state : { documents: { ...state.documents, [id]: next } }
}

function updateDocument(state: WorkspaceState, id: string, update: (document: AnnotationDocument) => AnnotationDocument): Partial<WorkspaceState> {
  return updateTab(state, id, (tab) => tab.document ? { ...tab, document: update(tab.document) } : tab)
}

function mutateAnnotations(state: WorkspaceState, id: string, update: (annotations: Annotation[]) => Annotation[]): Partial<WorkspaceState> {
  const tab = state.documents[id]; if (!tab?.document) return state
  const annotations = update(tab.document.annotations)
  if (annotations === tab.document.annotations) return state
  return updateTab(state, id, (current) => ({
    ...current, document: { ...current.document!, annotations, modifiedAt: now() },
    past: [...current.past, current.document!.annotations], future: [],
  }))
}

function now(): string { return new Date().toISOString() }
