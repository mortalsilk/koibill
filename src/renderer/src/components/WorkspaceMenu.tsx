import { useEffect, useRef, useState } from 'react'
import { ChevronDown, FolderOpen, FolderPlus, Settings, X } from 'lucide-react'
import type { ResearchWorkspace, UiState, WorkspaceLibrarySettings, WorkspaceSwitchResult } from '../../../shared/types'
import { flushWorkspaceEditors } from '../persistence'

interface Props {
  library: WorkspaceLibrarySettings
  onLibrary: (library: WorkspaceLibrarySettings) => void
  onWorkspace: (workspace: ResearchWorkspace, ui?: UiState) => void
}

export function WorkspaceMenu({ library, onLibrary, onWorkspace }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [dialogMode, setDialogMode] = useState<'create' | 'rename' | 'settings' | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const active = library.workspaces.find((item) => item.id === library.activeWorkspaceId)

  useEffect(() => {
    const close = (event: MouseEvent): void => { if (!menuRef.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const refresh = async (): Promise<void> => onLibrary(await window.koibill.getWorkspaceLibrary())
  const prepare = async (): Promise<void> => {
    if (!library.activeWorkspaceId) return
    await flushWorkspaceEditors()
  }
  const accept = async (result: WorkspaceSwitchResult): Promise<void> => {
    if (result.switched && result.workspace) { window.dispatchEvent(new Event('koibill:workspace-unload')); onWorkspace(result.workspace, result.ui) }
    await refresh(); setOpen(false)
  }
  const run = async (operation: () => Promise<WorkspaceSwitchResult>, flush = true): Promise<void> => {
    setBusy(true); setError('')
    try { if (flush) await prepare(); await accept(await operation()); setRetryAction(null) }
    catch (reason) { setError(String(reason)); setRetryAction(() => () => { void run(operation, flush) }) }
    finally { setBusy(false) }
  }
  const submitName = (): void => {
    const next = name.trim()
    if (!next) return
    if (dialogMode === 'create') void run(() => window.koibill.createWorkspace(next), Boolean(library.activeWorkspaceId)).then(() => setDialogMode(null))
    if (dialogMode === 'rename' && active) {
      setBusy(true); setError('')
      void flushWorkspaceEditors().then(() => window.koibill.renameWorkspace(active.id, next)).then(async () => { await refresh(); setDialogMode(null) }).catch((reason) => setError(String(reason))).finally(() => setBusy(false))
    }
  }

  return <>
    <header className="workspace-bar">
      <div ref={menuRef} className="workspace-menu-host">
        <button className="workspace-menu-button" onClick={() => setOpen((value) => !value)} aria-expanded={open}><strong>koibill</strong><span>{active?.name ?? 'No workspace'}</span><ChevronDown size={14}/></button>
        {open && <div className="workspace-menu" role="menu">
          <button onClick={() => { setName(''); setDialogMode('create'); setOpen(false) }}><FolderPlus size={14}/> New Workspace</button>
          <button onClick={() => void run(() => window.koibill.openWorkspace(), Boolean(active))}><FolderOpen size={14}/> Open Existing Workspace</button>
          <div className="workspace-menu-section">Recent workspaces</div>
          {library.workspaces.slice(0, 10).map((workspace) => <button key={workspace.id} className={workspace.active ? 'active' : ''} disabled={workspace.active || busy || !workspace.available} onClick={() => void run(() => window.koibill.switchWorkspace(workspace.id))}><span>{workspace.name}</span>{workspace.active ? <small>Active</small> : !workspace.available ? <small>Missing</small> : null}</button>)}
          {!library.workspaces.length && <p>No recent workspaces</p>}
          <div className="workspace-menu-separator"/>
          <button disabled={!active} onClick={() => { setName(active?.name ?? ''); setDialogMode('rename'); setOpen(false) }}>Rename Workspace</button>
          <button disabled={!active} onClick={() => active && void window.koibill.revealWorkspace(active.id)}>Reveal Workspace Folder</button>
          <button disabled={!active} onClick={() => active && void (async () => { try { await prepare(); const next = await window.koibill.unregisterWorkspace(active.id); window.dispatchEvent(new Event('koibill:workspace-unload')); onLibrary(next); onWorkspace({ schemaVersion: 1, documents: [], activeDocumentId: null, tray: [], question: '' }); setOpen(false) } catch (reason) { setError(String(reason)) } })()}>Remove from Recents</button>
          <button onClick={() => { setDialogMode('settings'); setOpen(false) }}><Settings size={14}/> Settings</button>
        </div>}
      </div>
      {error && <div className="workspace-error" role="alert"><span>{error}</span>{retryAction && <button onClick={retryAction}>Retry</button>}{active && <button onClick={() => void window.koibill.revealWorkspace(active.id)}>Reveal Folder</button>}<button className="icon-button small" aria-label="Dismiss" onClick={() => { setError(''); setRetryAction(null) }}><X size={12}/></button></div>}
    </header>
    {dialogMode && <div className="modal-backdrop workspace-modal-backdrop"><form className="modal workspace-dialog" onSubmit={(event) => { event.preventDefault(); submitName() }}>
      <header><h2>{dialogMode === 'create' ? 'New workspace' : dialogMode === 'rename' ? 'Rename workspace' : 'Workspace settings'}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setDialogMode(null)}><X size={15}/></button></header>
      {dialogMode === 'settings' ? <><label>Workspace library<input readOnly value={library.rootLabel}/></label><p>Changing this location affects new workspaces only. Existing workspaces stay registered where they are.</p><button type="button" className="primary-button" onClick={() => void window.koibill.chooseWorkspaceRoot().then(onLibrary)}>Choose another location</button></> : <><label>Workspace name<input autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)}/></label><div className="modal-actions"><button type="button" onClick={() => setDialogMode(null)}>Cancel</button><button className="primary-button" disabled={!name.trim() || busy}>{dialogMode === 'create' ? 'Create workspace' : 'Rename'}</button></div></>}
    </form></div>}
  </>
}

export function WorkspaceChooser({ library, onLibrary, onWorkspace }: Props): React.JSX.Element {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const accept = async (result: WorkspaceSwitchResult): Promise<void> => {
    if (result.switched && result.workspace) onWorkspace(result.workspace, result.ui)
    onLibrary(await window.koibill.getWorkspaceLibrary())
  }
  return <section className="workspace-chooser"><div className="workspace-chooser-card"><div className="empty-mark">K</div><h1>Choose a workspace</h1><p>Each workspace keeps its copied PDFs, annotations, Markdown notes, research tray, and graphs together.</p><form onSubmit={(event) => { event.preventDefault(); if (name.trim()) void window.koibill.createWorkspace(name.trim()).then(accept).catch((reason) => setError(String(reason))) }}><input autoFocus placeholder="Workspace name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)}/><button className="primary-button" disabled={!name.trim()}>Create</button></form><button onClick={() => void window.koibill.openWorkspace().then(accept).catch((reason) => setError(String(reason)))}>Open Existing Workspace</button>{library.workspaces.length > 0 && <div className="chooser-recents"><strong>Recent</strong>{library.workspaces.slice(0, 10).map((item) => <button key={item.id} disabled={!item.available} onClick={() => void window.koibill.switchWorkspace(item.id).then(accept).catch((reason) => setError(String(reason)))}>{item.name}{item.available ? '' : ' — missing'}</button>)}</div>}{error && <p className="error-text">{error}</p>}</div></section>
}
