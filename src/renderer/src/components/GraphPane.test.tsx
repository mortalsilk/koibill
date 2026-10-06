// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphAppendPayload, GraphDocument, KoibillApi } from '../../../shared/types'

vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ReactFlow: ({ nodes }: { nodes: Array<{ id: string; data: { title: string; sources: unknown[] } }> }) => <div data-testid="flow">{nodes.map((node) => <div data-testid="flow-node" data-sources={node.data.sources.length} key={node.id}>{node.data.title}</div>)}</div>,
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  BackgroundVariant: { Dots: 'dots' },
  addEdge: (edge: unknown, edges: unknown[]) => [...edges, edge],
  applyEdgeChanges: (_changes: unknown, edges: unknown[]) => edges,
  applyNodeChanges: (_changes: unknown, nodes: unknown[]) => nodes,
}))

import { GraphPane } from './GraphPane'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function emptyGraph(nodes: GraphDocument['nodes'] = []): GraphDocument {
  return { schemaVersion: 1, sourceFingerprint: 'fp', sourceFilename: 'book.pdf', modifiedAt: 'now', viewport: { x: 0, y: 0, zoom: 1 }, nodes, edges: [] }
}

function setup(graph: GraphDocument): { append: (payload: GraphAppendPayload) => void; saveGraph: ReturnType<typeof vi.fn> } {
  let listener: (payload: GraphAppendPayload) => void = () => undefined
  const saveGraph = vi.fn().mockResolvedValue(undefined)
  window.koibill = {
    getGraph: vi.fn().mockResolvedValue(graph),
    saveGraph,
    onGraphAppend: vi.fn((callback: (payload: GraphAppendPayload) => void) => { listener = callback; return () => undefined }),
    onWorkspaceFlushRequest: vi.fn(() => () => undefined),
    browserCommand: vi.fn(),
  } as unknown as KoibillApi
  return { append: (payload) => listener(payload), saveGraph }
}

function renderGraph(): void {
  render(<GraphPane active sessionId="session" documentId="document" fingerprint="fp" documentName="book.pdf" pageNumber={6} onShowGraph={() => undefined} onShowBrowser={() => undefined} onGoToPage={() => undefined}/>)
}

describe('Graph pane generated titles', () => {
  it('generates a keyword header for a new source node and preserves it on later appends', async () => {
    const harness = setup(emptyGraph())
    renderGraph()
    await screen.findByTestId('flow')

    act(() => harness.append({ documentId: 'document', source: { kind: 'pdf', excerpt: 'Neural plasticity supports adaptive learning and neural plasticity enables recovery.', pageNumber: 6 } }))
    const created = await screen.findByTestId('flow-node')
    const generatedTitle = created.textContent
    expect(generatedTitle).toMatch(/neural plasticity/iu)

    act(() => harness.append({ source: { kind: 'chatgpt', excerpt: 'A later explanation should become another source.', pageNumber: 6, url: 'https://chatgpt.com/c/example' } }))
    await waitFor(() => expect(screen.getAllByTestId('flow-node')).toHaveLength(1))
    expect(screen.getByTestId('flow-node').textContent).toBe(generatedTitle)
    expect(screen.getByTestId('flow-node').dataset.sources).toBe('2')
  })

  it('keeps manual and persisted titles unchanged', async () => {
    const existing = {
      id: 'existing', position: { x: 0, y: 0 }, title: 'ChatGPT insight', userText: '', sources: [], createdAt: 'now', modifiedAt: 'now',
    }
    setup(emptyGraph([existing]))
    renderGraph()
    expect((await screen.findByTestId('flow-node')).textContent).toBe('ChatGPT insight')

    fireEvent.click(screen.getByRole('button', { name: 'Idea' }))
    await waitFor(() => expect(screen.getAllByTestId('flow-node')).toHaveLength(2))
    expect(screen.getAllByTestId('flow-node').map((node) => node.textContent)).toContain('New idea')
    expect(screen.getAllByTestId('flow-node').map((node) => node.textContent)).toContain('ChatGPT insight')
  })
})
