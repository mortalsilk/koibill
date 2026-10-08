// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KoibillApi } from '../../../shared/types'
import { NotesPane } from './NotesPane'

afterEach(cleanup)

describe('per-page Markdown notes', () => {
  it('offers lazy creation and opens the created page file', async () => {
    const createPageNote = vi.fn().mockResolvedValue({
      pageNumber: 7,
      exists: true,
      content: '# Field Guide — Page 7\n\n',
      pathLabel: 'koibill-Field Guide/notes/page-0007.md',
    })
    window.koibill = {
      getPageNote: vi.fn().mockResolvedValue({
        pageNumber: 7,
        exists: false,
        content: '',
        pathLabel: 'koibill-Field Guide/notes/page-0007.md',
      }),
      createPageNote,
      savePageNote: vi.fn(),
      onWorkspaceFlushRequest: vi.fn(() => () => undefined),
      browserCommand: vi.fn(),
    } as unknown as KoibillApi

    render(<NotesPane active sessionId="session-1" documentName="Field Guide.pdf" pageNumber={7} onOpenBrowser={() => undefined}/>)

    expect(await screen.findByText('No note for this page yet')).toBeTruthy()
    expect(screen.getAllByText('koibill-Field Guide/notes/page-0007.md')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Create page 7 note' }))

    await waitFor(() => expect(createPageNote).toHaveBeenCalledWith('session-1', 7))
    expect((await screen.findByRole('textbox', { name: 'Markdown note for page 7' }) as HTMLTextAreaElement).value).toBe('# Field Guide — Page 7\n\n')
  })

  it('does not load a note while the notes surface is inactive', () => {
    const getPageNote = vi.fn()
    window.koibill = { getPageNote, onWorkspaceFlushRequest: vi.fn(() => () => undefined) } as unknown as KoibillApi
    render(<NotesPane active={false} sessionId="session-1" documentName="Field Guide.pdf" pageNumber={2} onOpenBrowser={() => undefined}/>)
    expect(getPageNote).not.toHaveBeenCalled()
  })

  it('switches to an independent PDF-wide note', async () => {
    const getDocumentNote = vi.fn().mockResolvedValue({
      exists: false,
      content: '',
      pathLabel: 'koibill-Field Guide/notes/document.md',
    })
    const createDocumentNote = vi.fn().mockResolvedValue({
      exists: true,
      content: '# Field Guide\n\n',
      pathLabel: 'koibill-Field Guide/notes/document.md',
    })
    window.koibill = {
      getPageNote: vi.fn().mockResolvedValue({ pageNumber: 3, exists: false, content: '', pathLabel: 'koibill-Field Guide/notes/page-0003.md' }),
      getDocumentNote,
      createDocumentNote,
      savePageNote: vi.fn(),
      saveDocumentNote: vi.fn(),
      onWorkspaceFlushRequest: vi.fn(() => () => undefined),
      browserCommand: vi.fn(),
    } as unknown as KoibillApi

    const view = render(<NotesPane active sessionId="session-1" documentName="Field Guide.pdf" pageNumber={3} onOpenBrowser={() => undefined}/>)
    await screen.findByText('No note for this page yet')
    fireEvent.click(screen.getByRole('button', { name: 'Document' }))

    expect(await screen.findByText('No document note yet')).toBeTruthy()
    expect(getDocumentNote).toHaveBeenCalledWith('session-1')
    view.rerender(<NotesPane active sessionId="session-1" documentName="Field Guide.pdf" pageNumber={4} onOpenBrowser={() => undefined}/>)
    expect(getDocumentNote).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Create document note' }))
    await waitFor(() => expect(createDocumentNote).toHaveBeenCalledWith('session-1'))
    expect((await screen.findByRole('textbox', { name: 'Markdown note for entire PDF' }) as HTMLTextAreaElement).value).toBe('# Field Guide\n\n')
  })

  it('keeps Markdown formatting available through the compact overflow menu', async () => {
    window.koibill = {
      getPageNote: vi.fn().mockResolvedValue({ pageNumber: 2, exists: true, content: 'Existing note', pathLabel: 'notes/page-0002.md' }),
      savePageNote: vi.fn().mockResolvedValue({ pageNumber: 2, exists: true, content: '', pathLabel: 'notes/page-0002.md' }),
      onWorkspaceFlushRequest: vi.fn(() => () => undefined),
      browserCommand: vi.fn(),
    } as unknown as KoibillApi

    render(<NotesPane active sessionId="session-1" documentName="Field Guide.pdf" pageNumber={2} onOpenBrowser={() => undefined}/>)
    const editor = await screen.findByRole('textbox', { name: 'Markdown note for page 2' }) as HTMLTextAreaElement
    fireEvent.click(screen.getByRole('button', { name: 'Markdown formatting' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Markdown formatting' })).getByRole('button', { name: 'Bold' }))
    expect(editor.value).toBe('**text**Existing note')
    expect(screen.queryByRole('dialog', { name: 'Markdown formatting' })).toBeNull()
  })
})
