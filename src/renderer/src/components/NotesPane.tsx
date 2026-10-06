import { useCallback, useEffect, useRef, useState } from 'react'
import { Bold, Braces, CheckSquare, Eye, Heading2, Italic, Link, List, ListOrdered, PencilLine, Quote, Rows3 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { registerWorkspaceFlusher } from '../persistence'

type ViewMode = 'edit' | 'split' | 'preview'
type NoteScope = 'document' | 'page'

interface NotesPaneProps {
  active: boolean
  sessionId?: string
  documentName?: string
  pageNumber: number
  onOpenBrowser: () => void
}

export function NotesPane({ active, sessionId, documentName, pageNumber, onOpenBrowser }: NotesPaneProps): React.JSX.Element {
  const [mode, setMode] = useState<ViewMode>('split')
  const [scope, setScope] = useState<NoteScope>('page')
  const [value, setValue] = useState('')
  const [state, setState] = useState<'idle' | 'loading' | 'missing' | 'ready' | 'saving' | 'error'>('idle')
  const [pathLabel, setPathLabel] = useState('')
  const [error, setError] = useState('')
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const noteRef = useRef<{ sessionId: string; scope: NoteScope; pageNumber?: number; value: string; dirty: boolean } | null>(null)
  const words = value.trim() ? value.trim().split(/\s+/u).length : 0
  const editingAvailable = state === 'ready' || state === 'saving'
  const scopedPageNumber = scope === 'page' ? pageNumber : 0

  const flushNote = useCallback(async (): Promise<void> => {
    const note = noteRef.current
    if (!note?.dirty) return
    const result = note.scope === 'document'
      ? await window.koibill.saveDocumentNote(note.sessionId, note.value)
      : await window.koibill.savePageNote(note.sessionId, note.pageNumber!, note.value)
    if (noteRef.current === note) noteRef.current.dirty = false
    setPathLabel(result.pathLabel)
  }, [])

  useEffect(() => registerWorkspaceFlusher(flushNote), [flushNote])

  useEffect(() => {
    if (!active) return
    const previous = noteRef.current
    if (previous?.dirty) {
      previous.dirty = false
      if (previous.scope === 'document') void window.koibill.saveDocumentNote(previous.sessionId, previous.value)
      else void window.koibill.savePageNote(previous.sessionId, previous.pageNumber!, previous.value)
    }
    if (!sessionId) {
      noteRef.current = null
      setValue('')
      setState('idle')
      setPathLabel('')
      return
    }
    let cancelled = false
    setState('loading')
    setError('')
    const request = scope === 'document' ? window.koibill.getDocumentNote(sessionId) : window.koibill.getPageNote(sessionId, scopedPageNumber)
    void request.then((note) => {
      if (cancelled) return
      noteRef.current = { sessionId, scope, pageNumber: scope === 'page' ? scopedPageNumber : undefined, value: note.content, dirty: false }
      setValue(note.content)
      setPathLabel(note.pathLabel)
      setState(note.exists ? 'ready' : 'missing')
    }).catch((reason) => {
      if (!cancelled) { setError(String(reason)); setState('error') }
    })
    return () => { cancelled = true }
  }, [active, sessionId, scope, scopedPageNumber])

  useEffect(() => {
    if (state !== 'ready' || !noteRef.current?.dirty) return
    const expected = noteRef.current
    const timeout = window.setTimeout(() => {
      setState('saving')
      const request = expected.scope === 'document'
        ? window.koibill.saveDocumentNote(expected.sessionId, expected.value)
        : window.koibill.savePageNote(expected.sessionId, expected.pageNumber!, expected.value)
      void request.then((note) => {
        if (noteRef.current === expected) noteRef.current.dirty = false
        setPathLabel(note.pathLabel)
        setState('ready')
      }).catch((reason) => { setError(String(reason)); setState('error') })
    }, 350)
    return () => window.clearTimeout(timeout)
  }, [state, value])

  useEffect(() => window.koibill.onWorkspaceFlushRequest(() => { void flushNote() }), [flushNote])

  const changeValue = (next: string): void => {
    setValue(next)
    if (noteRef.current) {
      noteRef.current.value = next
      noteRef.current.dirty = true
      setState('ready')
    }
  }

  const createNote = (): void => {
    if (!sessionId) return
    setState('loading')
    const request = scope === 'document' ? window.koibill.createDocumentNote(sessionId) : window.koibill.createPageNote(sessionId, pageNumber)
    void request.then((note) => {
      noteRef.current = { sessionId, scope, pageNumber: scope === 'page' ? pageNumber : undefined, value: note.content, dirty: false }
      setValue(note.content)
      setPathLabel(note.pathLabel)
      setState('ready')
      requestAnimationFrame(() => editorRef.current?.focus())
    }).catch((reason) => { setError(String(reason)); setState('error') })
  }
  const openLink = (href: string | undefined): void => {
    if (!href) return
    try {
      const url = new URL(href)
      if (url.protocol === 'https:') {
        onOpenBrowser()
        void window.koibill.browserCommand({ type: 'new-tab', url: url.href })
      }
    } catch { /* Ignore malformed Markdown links. */ }
  }

  const wrap = (before: string, after = before, placeholder = 'text'): void => {
    const editor = editorRef.current
    if (!editor) return
    const start = editor.selectionStart
    const end = editor.selectionEnd
    const selected = value.slice(start, end) || placeholder
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`
    changeValue(next)
    requestAnimationFrame(() => {
      editor.focus()
      editor.setSelectionRange(start + before.length, start + before.length + selected.length)
    })
  }

  const line = (prefix: string, placeholder: string): void => {
    const editor = editorRef.current
    if (!editor) return
    const start = value.lastIndexOf('\n', Math.max(0, editor.selectionStart - 1)) + 1
    const endAt = value.indexOf('\n', editor.selectionEnd)
    const end = endAt < 0 ? value.length : endAt
    const selected = value.slice(start, end) || placeholder
    const next = selected.split('\n').map((entry) => `${prefix}${entry}`).join('\n')
    changeValue(`${value.slice(0, start)}${next}${value.slice(end)}`)
    requestAnimationFrame(() => { editor.focus(); editor.setSelectionRange(start + prefix.length, start + next.length) })
  }

  return (
    <section className="notes-pane" aria-label="Markdown notes">
      <header className="notes-toolbar">
        <div className="notes-scope-switcher" role="group" aria-label="Note scope">
          <button className={scope === 'document' ? 'active' : ''} onClick={() => setScope('document')}>Document</button>
          <button className={scope === 'page' ? 'active' : ''} onClick={() => setScope('page')}>Page {pageNumber}</button>
        </div>
        <div className="notes-formatting" aria-label="Markdown formatting">
          <button disabled={!editingAvailable} title="Heading" onClick={() => line('## ', 'Heading')}><Heading2 size={15}/></button>
          <button disabled={!editingAvailable} title="Bold" onClick={() => wrap('**', '**')}><Bold size={15}/></button>
          <button disabled={!editingAvailable} title="Italic" onClick={() => wrap('_', '_')}><Italic size={15}/></button>
          <button disabled={!editingAvailable} title="Bulleted list" onClick={() => line('- ', 'List item')}><List size={15}/></button>
          <button disabled={!editingAvailable} title="Numbered list" onClick={() => line('1. ', 'List item')}><ListOrdered size={15}/></button>
          <button disabled={!editingAvailable} title="Task" onClick={() => line('- [ ] ', 'Task')}><CheckSquare size={15}/></button>
          <button disabled={!editingAvailable} title="Quote" onClick={() => line('> ', 'Quote')}><Quote size={15}/></button>
          <button disabled={!editingAvailable} title="Inline code" onClick={() => wrap('`', '`', 'code')}><Braces size={15}/></button>
          <button disabled={!editingAvailable} title="Link" onClick={() => wrap('[', '](https://)', 'label')}><Link size={15}/></button>
        </div>
        <div className="notes-view-modes" role="group" aria-label="Notes view">
          <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')} title="Edit"><PencilLine size={14}/><span>Edit</span></button>
          <button className={mode === 'split' ? 'active' : ''} onClick={() => setMode('split')} title="Split"><Rows3 size={14}/><span>Split</span></button>
          <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')} title="Preview"><Eye size={14}/><span>Preview</span></button>
        </div>
      </header>
      {!sessionId && <div className="notes-empty"><strong>No PDF selected</strong><p>Import and select a PDF to create page notes.</p></div>}
      {sessionId && state === 'loading' && <div className="notes-empty"><strong>Loading {scope === 'document' ? 'document note' : `page ${pageNumber}`}…</strong></div>}
      {sessionId && state === 'missing' && <div className="notes-empty"><span className="notes-page-kicker">{documentName}{scope === 'page' ? ` · page ${pageNumber}` : ' · entire PDF'}</span><strong>{scope === 'document' ? 'No document note yet' : 'No note for this page yet'}</strong><p>{scope === 'document' ? 'Create one Markdown note for ideas, summaries, and references that apply to the entire PDF.' : `Create a Markdown file for page ${pageNumber}. Other pages stay untouched until you create notes for them.`}</p><button className="primary-button" onClick={createNote}>{scope === 'document' ? 'Create document note' : `Create page ${pageNumber} note`}</button><small>{pathLabel}</small></div>}
      {sessionId && state === 'error' && <div className="notes-empty"><strong>Unable to open this note</strong><p>{error}</p><button onClick={() => setState('missing')}>Try again</button></div>}
      {sessionId && (state === 'ready' || state === 'saving') && <div className={`notes-canvas mode-${mode}`}>
        {mode !== 'preview' && <textarea ref={editorRef} className="notes-editor" aria-label={scope === 'document' ? 'Markdown note for entire PDF' : `Markdown note for page ${pageNumber}`} value={value} onChange={(event) => changeValue(event.target.value)} spellCheck placeholder={scope === 'document' ? '# Document notes\n\nWrite in Markdown…' : '# Page notes\n\nWrite in Markdown…'} />}
        {mode !== 'edit' && <article className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={(event) => { event.preventDefault(); openLink(href) }}>{children}</a> }}>{value}</ReactMarkdown></article>}
      </div>}
      <footer className="notes-status"><span>{sessionId ? `${documentName ?? 'PDF'} · ${scope === 'document' ? 'document' : `page ${pageNumber}`}` : 'Markdown notes'}</span><span>{state === 'saving' ? 'Saving…' : state === 'ready' ? `${words.toLocaleString()} words · ${value.length.toLocaleString()} characters` : pathLabel}</span></footer>
    </section>
  )
}
