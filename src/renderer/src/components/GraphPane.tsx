import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, BackgroundVariant, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider,
  addEdge, applyEdgeChanges, applyNodeChanges,
  type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps, type ReactFlowInstance, type Viewport,
} from '@xyflow/react'
import { Maximize2, Plus, Redo2, Search, Trash2, Undo2, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { GraphAppendPayload, GraphDocument, GraphEdgeRecord, GraphNodeRecord, GraphSource } from '../../../shared/types'
import { generateGraphNodeTitle } from '../../../shared/graph-title'
import { getAIProvider } from '../../../shared/ai-providers'
import { registerWorkspaceFlusher } from '../persistence'
import '@xyflow/react/dist/style.css'

interface IdeaNodeData extends Record<string, unknown> {
  title: string
  userText: string
  sources: GraphSource[]
  createdAt: string
  modifiedAt: string
}

type IdeaNode = Node<IdeaNodeData, 'idea'>
type IdeaEdge = Edge<{ createdAt: string }>
interface Snapshot { nodes: IdeaNode[]; edges: IdeaEdge[] }

interface GraphPaneProps {
  active: boolean
  sessionId?: string
  documentId?: string
  fingerprint?: string
  documentName?: string
  pageNumber: number
  onShowGraph: () => void
  onShowBrowser: () => void
  onGoToPage: (page: number) => void
}

const nodeTypes = { idea: GraphIdeaNode }

export function GraphPane(props: GraphPaneProps): React.JSX.Element {
  return <ReactFlowProvider><GraphCanvas {...props}/></ReactFlowProvider>
}

function GraphCanvas({ active, sessionId, documentId, fingerprint, documentName, pageNumber, onShowGraph, onShowBrowser, onGoToPage }: GraphPaneProps): React.JSX.Element {
  const hostRef = useRef<HTMLElement>(null)
  const instanceRef = useRef<ReactFlowInstance<IdeaNode, IdeaEdge> | null>(null)
  const nodesRef = useRef<IdeaNode[]>([])
  const edgesRef = useRef<IdeaEdge[]>([])
  const dirtyRef = useRef(false)
  const editStartRef = useRef<Snapshot | null>(null)
  const dragStartRef = useRef<Snapshot | null>(null)
  const pendingAppendRef = useRef<GraphAppendPayload[]>([])
  const [nodes, setNodes] = useState<IdeaNode[]>([])
  const [edges, setEdges] = useState<IdeaEdge[]>([])
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 })
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null)
  const [loadedDocument, setLoadedDocument] = useState<{ fingerprint: string; name: string } | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  const [past, setPast] = useState<Snapshot[]>([])
  const [future, setFuture] = useState<Snapshot[]>([])
  const selectedNode = nodes.find((node) => node.id === selectedNodeId)

  useEffect(() => { nodesRef.current = nodes }, [nodes])
  useEffect(() => { edgesRef.current = edges }, [edges])

  const graphDocument = useCallback((): GraphDocument | null => {
    if (!loadedDocument) return null
    return {
      schemaVersion: 1,
      sourceFingerprint: loadedDocument.fingerprint,
      sourceFilename: loadedDocument.name,
      modifiedAt: new Date().toISOString(),
      viewport,
      nodes: nodesRef.current.map(toGraphNode),
      edges: edgesRef.current.map(toGraphEdge),
    }
  }, [loadedDocument, viewport])

  const saveNow = useCallback(async (): Promise<void> => {
    const graph = graphDocument()
    if (!loadedSessionId || !graph || !dirtyRef.current) return
    dirtyRef.current = false
    try { await window.koibill.saveGraph(loadedSessionId, graph) }
    catch (error) { dirtyRef.current = true; setMessage(`Graph save failed: ${String(error)}`); throw error }
  }, [graphDocument, loadedSessionId])

  useEffect(() => {
    if (!sessionId) {
      setNodes([]); setEdges([]); setLoadedSessionId(null); setLoadedDocument(null); setSelectedNodeId(null)
      return
    }
    let cancelled = false
    const previousSession = loadedSessionId
    if (previousSession && previousSession !== sessionId) void saveNow()
    setMessage('Loading graph…')
    void window.koibill.getGraph(sessionId).then((graph) => {
      if (cancelled) return
      const nextNodes = graph.nodes.map(toFlowNode)
      const nextEdges = graph.edges.map(toFlowEdge)
      nodesRef.current = nextNodes; edgesRef.current = nextEdges
      setNodes(nextNodes); setEdges(nextEdges); setViewport(graph.viewport)
      setLoadedSessionId(sessionId); setLoadedDocument({ fingerprint: graph.sourceFingerprint, name: graph.sourceFilename }); setSelectedNodeId(null); setPast([]); setFuture([])
      dirtyRef.current = false; setMessage('')
      requestAnimationFrame(() => void instanceRef.current?.setViewport(graph.viewport))
    }).catch((error) => { if (!cancelled) setMessage(`Unable to load graph: ${String(error)}`) })
    return () => { cancelled = true }
  }, [sessionId])

  useEffect(() => {
    if (!dirtyRef.current || !sessionId || loadedSessionId !== sessionId) return
    const timeout = window.setTimeout(() => void saveNow(), 600)
    return () => window.clearTimeout(timeout)
  }, [nodes, edges, viewport, sessionId, loadedSessionId, saveNow])

  useEffect(() => window.koibill.onWorkspaceFlushRequest(() => { void saveNow() }), [saveNow])
  useEffect(() => registerWorkspaceFlusher(saveNow), [saveNow])

  const remember = useCallback((snapshot: Snapshot = cloneSnapshot(nodesRef.current, edgesRef.current)): void => {
    setPast((items) => [...items.slice(-99), snapshot])
    setFuture([])
  }, [])

  const positionForNewNode = (): { x: number; y: number } => {
    const rect = hostRef.current?.getBoundingClientRect()
    if (rect && instanceRef.current) {
      const center = instanceRef.current.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      if (!nodesRef.current.length) return center
      const index = nodesRef.current.length - 1
      const angle = index * 2.399963
      const radius = 300 + Math.floor(index / 8) * 120
      return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }
    }
    return { x: nodesRef.current.length * 28, y: nodesRef.current.length * 28 }
  }

  const addManualNode = (position = positionForNewNode()): void => {
    if (!sessionId) return
    remember()
    const timestamp = new Date().toISOString()
    const node: IdeaNode = {
      id: crypto.randomUUID(), type: 'idea', position,
      selected: true, data: { title: 'New idea', userText: '', sources: [], createdAt: timestamp, modifiedAt: timestamp },
    }
    setNodes((items) => [...items.map((item) => ({ ...item, selected: false })), node]); setSelectedNodeId(node.id); dirtyRef.current = true
  }

  const appendPayload = useCallback((payload: GraphAppendPayload): void => {
    if (!sessionId || !documentId || (payload.documentId && payload.documentId !== documentId)) return
    const timestamp = new Date().toISOString()
    const source: GraphSource = {
      ...payload.source,
      id: crypto.randomUUID(),
      pageNumber: payload.source.pageNumber ?? pageNumber,
      createdAt: timestamp,
    }
    remember()
    const selected = selectedNodeId && nodesRef.current.some((node) => node.id === selectedNodeId) ? selectedNodeId : null
    if (selected) {
      setNodes((items) => items.map((node) => node.id === selected ? {
        ...node, data: { ...node.data, sources: [...node.data.sources, source], modifiedAt: timestamp },
      } : node))
      setMessage('Excerpt appended to the selected idea.')
    } else {
      const title = generateGraphNodeTitle(source)
      const node: IdeaNode = {
        id: crypto.randomUUID(), type: 'idea', position: positionForNewNode(),
        selected: true, data: { title, userText: '', sources: [source], createdAt: timestamp, modifiedAt: timestamp },
      }
      setNodes((items) => [...items.map((item) => ({ ...item, selected: false })), node]); setSelectedNodeId(node.id)
      setMessage('New graph idea created.')
    }
    dirtyRef.current = true
    onShowGraph()
  }, [documentId, onShowGraph, pageNumber, remember, selectedNodeId, sessionId])

  useEffect(() => window.koibill.onGraphAppend((payload) => {
    if (loadedSessionId !== sessionId) pendingAppendRef.current.push(payload)
    else appendPayload(payload)
  }), [appendPayload, loadedSessionId, sessionId])

  useEffect(() => {
    if (!sessionId || loadedSessionId !== sessionId || !pendingAppendRef.current.length) return
    const pending = pendingAppendRef.current.splice(0)
    pending.forEach(appendPayload)
  }, [appendPayload, loadedSessionId, sessionId])

  const onNodesChange = (changes: NodeChange<IdeaNode>[]): void => {
    if (changes.some((change) => change.type === 'remove')) remember()
    if (changes.some((change) => ['position', 'dimensions', 'remove'].includes(change.type))) dirtyRef.current = true
    setNodes((items) => applyNodeChanges(changes, items))
  }

  const onEdgesChange = (changes: EdgeChange<IdeaEdge>[]): void => {
    if (changes.some((change) => change.type === 'remove')) remember()
    if (changes.some((change) => change.type === 'remove')) dirtyRef.current = true
    setEdges((items) => applyEdgeChanges(changes, items))
  }

  const connect = (connection: Connection): void => {
    remember()
    setEdges((items) => addEdge({ ...connection, id: crypto.randomUUID(), type: 'smoothstep', data: { createdAt: new Date().toISOString() } }, items))
    dirtyRef.current = true
  }

  const undo = (): void => {
    const previous = past.at(-1); if (!previous) return
    setFuture((items) => [cloneSnapshot(nodesRef.current, edgesRef.current), ...items].slice(0, 100))
    setPast((items) => items.slice(0, -1)); setNodes(previous.nodes); setEdges(previous.edges); setSelectedNodeId(null); dirtyRef.current = true
  }

  const redo = (): void => {
    const next = future[0]; if (!next) return
    setPast((items) => [...items, cloneSnapshot(nodesRef.current, edgesRef.current)].slice(-100))
    setFuture((items) => items.slice(1)); setNodes(next.nodes); setEdges(next.edges); setSelectedNodeId(null); dirtyRef.current = true
  }

  const updateSelected = (update: Partial<Pick<IdeaNodeData, 'title' | 'userText'>>): void => {
    if (!selectedNodeId) return
    setNodes((items) => items.map((node) => node.id === selectedNodeId
      ? { ...node, data: { ...node.data, ...update, modifiedAt: new Date().toISOString() } }
      : node))
    dirtyRef.current = true
  }

  const beginEdit = (): void => { editStartRef.current ??= cloneSnapshot(nodesRef.current, edgesRef.current) }
  const finishEdit = (): void => { if (editStartRef.current) { remember(editStartRef.current); editStartRef.current = null } }
  const removeSource = (sourceId: string): void => {
    if (!selectedNodeId) return
    remember()
    setNodes((items) => items.map((node) => node.id === selectedNodeId
      ? { ...node, data: { ...node.data, sources: node.data.sources.filter((source) => source.id !== sourceId), modifiedAt: new Date().toISOString() } }
      : node))
    dirtyRef.current = true
  }

  const openSource = (source: GraphSource): void => {
    if (source.kind === 'pdf') onGoToPage(source.pageNumber)
    else if (source.url) { onShowBrowser(); void window.koibill.browserCommand({ type: 'activate-or-open', tabId: source.browserTabId, url: source.url }) }
  }

  const runSearch = (event: React.FormEvent): void => {
    event.preventDefault()
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return
    const match = nodesRef.current.find((node) => `${node.data.title}\n${node.data.userText}\n${node.data.sources.map((source) => source.excerpt).join('\n')}`.toLocaleLowerCase().includes(normalized))
    if (!match) { setMessage(`No graph matches for “${query.trim()}”.`); return }
    setSelectedNodeId(match.id); void instanceRef.current?.fitView({ nodes: [match], padding: 1.2, duration: 280 })
  }

  const deleteSelected = (): void => {
    if (!selectedNodeId) return
    remember(); setNodes((items) => items.filter((node) => node.id !== selectedNodeId)); setEdges((items) => items.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId)); setSelectedNodeId(null); dirtyRef.current = true
  }

  const nodeCountLabel = `${nodes.length} idea${nodes.length === 1 ? '' : 's'} · ${edges.length} connection${edges.length === 1 ? '' : 's'}`

  return (
    <section ref={hostRef} className="graph-pane" aria-label="Graph notes">
      <header className="graph-toolbar">
        <button className="primary-button compact" disabled={!sessionId} onClick={() => addManualNode()}><Plus size={14}/> Idea</button>
        <button disabled={!past.length} onClick={undo} title="Undo"><Undo2 size={14}/></button>
        <button disabled={!future.length} onClick={redo} title="Redo"><Redo2 size={14}/></button>
        <button disabled={!nodes.length} onClick={() => void instanceRef.current?.fitView({ padding: .25, duration: 280 })} title="Fit graph"><Maximize2 size={14}/></button>
        <form onSubmit={runSearch}><Search size={13}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search graph"/></form>
        <span>{nodeCountLabel}</span>
      </header>
      {!sessionId ? <div className="graph-empty"><strong>No PDF selected</strong><p>Import and select a PDF to use its graph notes.</p></div> : loadedSessionId !== sessionId ? <div className="graph-empty"><strong>Loading graph…</strong></div> : <>
        <ReactFlow<IdeaNode, IdeaEdge>
          nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onConnect={connect} onInit={(instance) => { instanceRef.current = instance }}
          onDoubleClick={(event) => {
            if (!(event.target as HTMLElement).classList.contains('react-flow__pane')) return
            addManualNode(instanceRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? positionForNewNode())
          }}
          onSelectionChange={({ nodes: selected }) => setSelectedNodeId(selected[0]?.id ?? null)}
          onNodeDragStart={() => { dragStartRef.current = cloneSnapshot(nodesRef.current, edgesRef.current) }}
          onNodeDragStop={() => { if (dragStartRef.current) { remember(dragStartRef.current); dragStartRef.current = null; dirtyRef.current = true } }}
          onMoveEnd={(_event, nextViewport) => { setViewport(nextViewport); dirtyRef.current = true }}
          onEdgeDoubleClick={(_event, edge) => { const label = window.prompt('Connection label', typeof edge.label === 'string' ? edge.label : '')?.trim(); if (label === undefined) return; remember(); setEdges((items) => items.map((item) => item.id === edge.id ? { ...item, label: label.slice(0, 200) || undefined } : item)); dirtyRef.current = true }}
          minZoom={.08} maxZoom={4} fitView={!nodes.length} deleteKeyCode={['Backspace', 'Delete']} selectionOnDrag panOnScroll
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1}/><MiniMap pannable zoomable/><Controls showInteractive={false}/>
        </ReactFlow>
        {!nodes.length && <div className="graph-empty overlay"><strong>Your idea graph starts here</strong><p>Double-click the canvas, create an idea, or append selected text from the PDF or browser.</p><button className="primary-button" onClick={() => addManualNode()}>Create first idea</button></div>}
      </>}
      {selectedNode && <aside className="graph-inspector">
        <header><strong>Edit idea</strong><button onClick={() => setSelectedNodeId(null)}><X size={14}/></button></header>
        <label>Title<input value={selectedNode.data.title} maxLength={500} onFocus={beginEdit} onBlur={finishEdit} onChange={(event) => updateSelected({ title: event.target.value })}/></label>
        <label>Your Markdown<textarea value={selectedNode.data.userText} maxLength={100_000} onFocus={beginEdit} onBlur={finishEdit} onChange={(event) => updateSelected({ userText: event.target.value })} placeholder="Connect the evidence in your own words…"/></label>
        {selectedNode.data.userText && <article className="graph-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedNode.data.userText}</ReactMarkdown></article>}
        <div className="graph-sources"><strong>Sources</strong>{selectedNode.data.sources.length ? selectedNode.data.sources.map((source) => <article key={source.id}><div className="graph-source-card"><div><span>{source.kind === 'pdf' ? 'PDF' : source.kind === 'chatgpt' ? 'ChatGPT' : source.kind === 'ai' ? getAIProvider(source.provider ?? 'chatgpt').name : 'Web'}</span><button onClick={() => onGoToPage(source.pageNumber)}>Page {source.pageNumber}</button></div><button className="graph-source-main" onClick={() => openSource(source)}><p>{source.excerpt}</p></button></div><button title="Remove source" onClick={() => removeSource(source.id)}><X size={12}/></button></article>) : <p>No sources attached.</p>}</div>
        <button className="danger-button" onClick={deleteSelected}><Trash2 size={13}/> Delete idea</button>
      </aside>}
      {message && <button className="graph-message" onClick={() => setMessage('')}>{message}</button>}
    </section>
  )
}

function GraphIdeaNode({ data, selected }: NodeProps<IdeaNode>): React.JSX.Element {
  const pages = [...new Set(data.sources.map((source) => source.pageNumber))].sort((a, b) => a - b)
  return <article className={`graph-node ${selected ? 'selected' : ''}`}>
    <Handle type="target" position={Position.Left}/>
    <strong>{data.title || 'Untitled idea'}</strong>
    {data.userText && <p className="graph-node-note">{data.userText}</p>}
    {data.sources[0] && <blockquote>{data.sources[0].excerpt}</blockquote>}
    <footer><span>{data.sources.length} source{data.sources.length === 1 ? '' : 's'}</span>{pages.slice(0, 3).map((page) => <span key={page}>p. {page}</span>)}</footer>
    <Handle type="source" position={Position.Right}/>
  </article>
}

function toFlowNode(node: GraphNodeRecord): IdeaNode {
  return { id: node.id, type: 'idea', position: node.position, data: { title: node.title, userText: node.userText, sources: node.sources, createdAt: node.createdAt, modifiedAt: node.modifiedAt } }
}

function toGraphNode(node: IdeaNode): GraphNodeRecord {
  return { id: node.id, position: node.position, title: node.data.title, userText: node.data.userText, sources: node.data.sources, createdAt: node.data.createdAt, modifiedAt: node.data.modifiedAt }
}

function toFlowEdge(edge: GraphEdgeRecord): IdeaEdge {
  return { id: edge.id, source: edge.source, target: edge.target, label: edge.label, type: 'smoothstep', data: { createdAt: edge.createdAt } }
}

function toGraphEdge(edge: IdeaEdge): GraphEdgeRecord {
  return { id: edge.id, source: edge.source, target: edge.target, label: typeof edge.label === 'string' ? edge.label : undefined, createdAt: edge.data?.createdAt ?? new Date().toISOString() }
}

function cloneSnapshot(nodes: IdeaNode[], edges: IdeaEdge[]): Snapshot {
  return { nodes: structuredClone(nodes), edges: structuredClone(edges) }
}
