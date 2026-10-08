export type ToolMode = 'select' | 'highlight' | 'pen' | 'eraser'
export type AskAIMode = 'draft' | 'send'
export type AIProviderId = 'chatgpt' | 'claude' | 'gemini' | 'perplexity' | 'deepseek'

export interface NormalizedPoint { x: number; y: number }
export interface NormalizedRect extends NormalizedPoint { width: number; height: number }

export type SemanticBlockType = 'title' | 'heading' | 'paragraph' | 'list-item' | 'figure' | 'caption' | 'table' | 'equation'
export interface SemanticSourceSpan {
  pageNumber: number
  rects: NormalizedRect[]
  start: number
  end: number
}
export interface SemanticAssetRegion { pageNumber: number; rect: NormalizedRect; kind: 'figure' | 'table' | 'equation' }
export interface SemanticBlock {
  id: string
  type: SemanticBlockType
  text: string
  level?: number
  confidence: number
  sourceSpans: SemanticSourceSpan[]
  asset?: SemanticAssetRegion
}
export interface SemanticDocument {
  schemaVersion: 1
  extractorVersion: string
  sourceFingerprint: string
  sourceFilename: string
  pageCount: number
  completedPages: number[]
  blocks: SemanticBlock[]
  modifiedAt: string
}
export type ReflowViewMode = 'original' | 'reflow' | 'split'
export interface ReflowViewSettings { mode: ReflowViewMode; splitRatio: number }
export interface ReflowTypographySettings { fontScale: number; lineHeight: number; measure: number }

export interface AnnotationConversationLink {
  id: string
  provider: AIProviderId
  url: string
  title: string
  browserTabId?: string
  createdAt: string
}

export interface AnnotationReference { documentId: string; annotationId: string }

interface AnnotationBase {
  id: string
  pageIndex: number
  color: string
  opacity: number
  createdAt: string
  note?: string
  conversationLinks?: AnnotationConversationLink[]
}

export interface HighlightAnnotation extends AnnotationBase {
  type: 'highlight'
  rects: NormalizedRect[]
  selectedText?: string
}

export interface InkAnnotation extends AnnotationBase {
  type: 'ink'
  points: NormalizedPoint[]
  width: number
}

export type Annotation = HighlightAnnotation | InkAnnotation

export interface PageMetadata { width: number; height: number; rotation: number }

export interface AnnotationDocument {
  schemaVersion: 2
  sourceFingerprint: string
  sourceFilename: string
  modifiedAt: string
  pages: PageMetadata[]
  annotations: Annotation[]
}

export interface PdfSession {
  id: string
  documentId: string
  name: string
  fingerprint: string
  bytes: Uint8Array
  annotations: AnnotationDocument
  fingerprintMismatch: boolean
  viewState?: PdfViewState
  researchItems?: ResearchTrayItem[]
}

export interface PdfPageNote {
  pageNumber: number
  exists: boolean
  content: string
  pathLabel: string
  modifiedAt?: string
}

export interface PdfDocumentNote {
  exists: boolean
  content: string
  pathLabel: string
  modifiedAt?: string
}

export type GraphSourceKind = 'pdf' | 'chatgpt' | 'ai' | 'web'

export interface GraphSource {
  id: string
  kind: GraphSourceKind
  provider?: AIProviderId
  excerpt: string
  pageNumber: number
  endPageNumber?: number
  sourceSpans?: SemanticSourceSpan[]
  url?: string
  title?: string
  browserTabId?: string
  createdAt: string
}

export interface GraphNodeRecord {
  id: string
  position: { x: number; y: number }
  title: string
  userText: string
  sources: GraphSource[]
  createdAt: string
  modifiedAt: string
}

export interface GraphEdgeRecord {
  id: string
  source: string
  target: string
  label?: string
  createdAt: string
}

export interface GraphDocument {
  schemaVersion: 1
  sourceFingerprint: string
  sourceFilename: string
  modifiedAt: string
  viewport: { x: number; y: number; zoom: number }
  nodes: GraphNodeRecord[]
  edges: GraphEdgeRecord[]
}

export interface GraphAppendPayload {
  documentId?: string
  source: Omit<GraphSource, 'id' | 'createdAt' | 'pageNumber'> & { pageNumber?: number }
}

export type PdfFocusUnit = 'line' | 'sentence' | 'paragraph'

export interface PdfFocusSettings {
  enabled: boolean
  unit: PdfFocusUnit
  surroundingVisibility: number
  magnification?: number
}

export interface PdfViewState {
  zoom: number
  rotation: number
  currentPage: number
  focus?: PdfFocusSettings
  reflow?: ReflowViewSettings
}

export interface PdfTabDescriptor {
  documentId: string
  name: string
  fingerprint?: string
  missing: boolean
  viewState?: PdfViewState
}

export interface RecentPdf { id: string; name: string }

export interface ResearchTrayItem {
  id: string
  documentId: string
  sourceFingerprint: string
  documentName: string
  pageNumber: number
  endPageNumber?: number
  sourceSpans?: SemanticSourceSpan[]
  text: string
  annotationId?: string
  createdAt: string
}

export interface ResearchWorkspace {
  schemaVersion: 1
  workspaceId?: string
  workspaceName?: string
  documents: PdfTabDescriptor[]
  activeDocumentId: string | null
  tray: ResearchTrayItem[]
  question: string
}

export interface WorkspaceDocumentRecord {
  id: string
  name: string
  open?: boolean
  relativeDirectory: string
  relativePdfPath: string
  fingerprint: string
  viewState?: PdfViewState
}

export interface WorkspaceBrowserTabRecord {
  id: string
  url: string
  zoomFactor: number
  lastActivatedAt: number
}

export interface WorkspaceBrowserState {
  tabs: WorkspaceBrowserTabRecord[]
  activeTabId: string | null
}

export interface WorkspaceManifest {
  schemaVersion: 1
  id: string
  name: string
  createdAt: string
  modifiedAt: string
  documents: WorkspaceDocumentRecord[]
  activeDocumentId: string | null
  tray: ResearchTrayItem[]
  question: string
  ui: UiState
  browser: WorkspaceBrowserState
}

export interface WorkspaceDescriptor {
  id: string
  name: string
  available: boolean
  active: boolean
  lastOpenedAt: string
}

export interface WorkspaceLibrarySettings {
  rootLabel: string
  workspaces: WorkspaceDescriptor[]
  activeWorkspaceId: string | null
}

export interface PdfImportRequest { workspaceId: string }
export interface PdfImportProgress {
  operationId: string
  state: 'copying' | 'finalizing' | 'complete' | 'cancelled' | 'error'
  fileName: string
  fileIndex: number
  fileCount: number
  fileBytes: number
  fileTotalBytes: number
  totalBytes: number
  totalBytesExpected: number
  message?: string
}

export interface WorkspaceSwitchResult {
  switched: boolean
  workspace?: ResearchWorkspace
  ui?: UiState
  message?: string
}

export interface WorkspaceUiState {
  documentIds: string[]
  activeDocumentId: string | null
  viewStates: Record<string, PdfViewState>
  tray: ResearchTrayItem[]
  question: string
}

export interface AnnotationFlushEntry { sessionId: string; document: AnnotationDocument }

export interface BrowserTabState {
  id: string
  url: string
  title: string
  favicon?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  active: boolean
  zoomFactor: number
  error?: string
}

export interface BrowserState { tabs: BrowserTabState[]; activeTabId: string | null }
export interface BrowserBounds { x: number; y: number; width: number; height: number }

interface AskAIBase {
  requestId: string
  provider: AIProviderId
  mode: AskAIMode
  linkTargets: AnnotationReference[]
}

export interface SelectionAskAIRequest extends AskAIBase {
  kind: 'selection'
  text: string
  documentName: string
  pageNumber: number
  endPageNumber?: number
  sourceSpans?: SemanticSourceSpan[]
}

export interface ResearchAskAIRequest extends AskAIBase {
  kind: 'research'
  question: string
  items: ResearchTrayItem[]
}

export type AskAIRequest = SelectionAskAIRequest | ResearchAskAIRequest

export interface AskAIFailure { request: AskAIRequest; prompt: string; message: string }

export interface AskAIStatus {
  requestId: string
  state: 'inserted' | 'pending' | 'linked' | 'cancelled'
  linkTargets: AnnotationReference[]
  link?: AnnotationConversationLink
  message?: string
}

export type SelectionMenuRequest = Omit<SelectionAskAIRequest, 'requestId' | 'provider' | 'mode' | 'linkTargets'> & {
  documentId: string
  sourceFingerprint: string
  annotationId?: string
  reflow?: boolean
}

export type BrowserCommand =
  | { type: 'new-tab'; url?: string }
  | { type: 'activate'; tabId: string }
  | { type: 'close'; tabId: string }
  | { type: 'move'; tabId: string; direction: -1 | 1 }
  | { type: 'navigate'; tabId: string; value: string }
  | { type: 'back'; tabId: string }
  | { type: 'forward'; tabId: string }
  | { type: 'reload'; tabId: string }
  | { type: 'stop'; tabId: string }
  | { type: 'external'; tabId: string }
  | { type: 'external-url'; url: string }
  | { type: 'activate-or-open'; tabId?: string; url: string }
  | { type: 'zoom-in'; tabId: string }
  | { type: 'zoom-out'; tabId: string }
  | { type: 'zoom-reset'; tabId: string }
  | { type: 'recover'; tabId: string }

export type RightPaneMode = 'browser' | 'notes' | 'graph'
export interface UiState {
  splitRatio: number
  rightPaneMode: RightPaneMode
}

export interface AppUiState extends UiState {
  rightPaneCollapsed: boolean
  reflowTypography: ReflowTypographySettings
}

export interface KoibillApi {
  openPdf(): Promise<PdfSession | null>
  importPdfs(): Promise<{ operationId?: string; sessions: PdfSession[]; cancelled?: boolean }>
  cancelPdfImport(operationId: string): void
  onPdfImportProgress(callback: (progress: PdfImportProgress) => void): () => void
  getWorkspaceLibrary(): Promise<WorkspaceLibrarySettings>
  createWorkspace(name: string): Promise<WorkspaceSwitchResult>
  openWorkspace(): Promise<WorkspaceSwitchResult>
  switchWorkspace(workspaceId: string): Promise<WorkspaceSwitchResult>
  renameWorkspace(workspaceId: string, name: string): Promise<WorkspaceDescriptor>
  unregisterWorkspace(workspaceId: string): Promise<WorkspaceLibrarySettings>
  revealWorkspace(workspaceId: string): Promise<void>
  chooseWorkspaceRoot(): Promise<WorkspaceLibrarySettings>
  openRecentPdf(id: string): Promise<PdfSession | null>
  restoreWorkspace(): Promise<ResearchWorkspace>
  loadWorkspacePdf(documentId: string): Promise<PdfSession | null>
  locateWorkspacePdf(documentId: string): Promise<PdfSession | null>
  saveWorkspace(state: WorkspaceUiState): Promise<void>
  closeWorkspacePdf(documentId: string): Promise<void>
  completeWorkspaceFlush(entries: AnnotationFlushEntry[], state: WorkspaceUiState): Promise<void>
  onWorkspaceFlushRequest(callback: () => void): () => void
  getRecentPdfs(): Promise<RecentPdf[]>
  saveAnnotations(sessionId: string, document: AnnotationDocument): Promise<{ saved: boolean; pathLabel?: string }>
  getPageNote(sessionId: string, pageNumber: number): Promise<PdfPageNote>
  createPageNote(sessionId: string, pageNumber: number): Promise<PdfPageNote>
  savePageNote(sessionId: string, pageNumber: number, content: string): Promise<PdfPageNote>
  getDocumentNote(sessionId: string): Promise<PdfDocumentNote>
  createDocumentNote(sessionId: string): Promise<PdfDocumentNote>
  saveDocumentNote(sessionId: string, content: string): Promise<PdfDocumentNote>
  getGraph(sessionId: string): Promise<GraphDocument>
  saveGraph(sessionId: string, graph: GraphDocument): Promise<void>
  getReflowCache(sessionId: string): Promise<SemanticDocument | null>
  saveReflowCache(sessionId: string, document: SemanticDocument): Promise<void>
  exportAnnotatedPdf(sessionId: string, document: AnnotationDocument): Promise<{ exported: boolean; pathLabel?: string }>
  showSelectionMenu(request: SelectionMenuRequest): void
  askAI(request: AskAIRequest): Promise<void>
  cancelAskAI(requestId: string): void
  retryAskAI(request: AskAIRequest): void
  copyText(text: string): Promise<void>
  setBrowserBounds(bounds: BrowserBounds): void
  setBrowserVisible(visible: boolean): void
  browserCommand(command: BrowserCommand): Promise<void>
  getBrowserState(): Promise<BrowserState>
  onBrowserState(callback: (state: BrowserState) => void): () => void
  onAskAIFailure(callback: (failure: AskAIFailure) => void): () => void
  onAskAIStatus(callback: (status: AskAIStatus) => void): () => void
  onResearchTrayItem(callback: (item: ResearchTrayItem) => void): () => void
  onGraphAppend(callback: (payload: GraphAppendPayload) => void): () => void
  onDownloadBlocked(callback: (url: string) => void): () => void
  onBrowserShowRequested(callback: () => void): () => void
  onRightPaneToggleRequested(callback: () => void): () => void
  onReflowSourceRequested(callback: (documentId: string, pageNumber: number) => void): () => void
  saveUiState(state: Partial<AppUiState>): Promise<void>
  getUiState(): Promise<AppUiState>
}
