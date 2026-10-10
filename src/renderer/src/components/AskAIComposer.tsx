import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { AIProviderId, AskAIComposerSeed, AskAIMode } from '../../../shared/types'
import { AI_PROVIDERS } from '../../../shared/ai-providers'
import { formatContextPrompt } from '../../../shared/prompt'
import { AIProviderSelect } from './AIProviderSelect'

export function AskAIComposer({ seed, onClose, onSingle, onCompare }: {
  seed: AskAIComposerSeed
  onClose: () => void
  onSingle: (provider: AIProviderId, mode: AskAIMode, prompt: string, contexts: AskAIComposerSeed['contexts'], edited: boolean) => void
  onCompare: (providers: AIProviderId[], prompt: string, contexts: AskAIComposerSeed['contexts'], edited: boolean) => void
}): React.JSX.Element {
  const [mode, setMode] = useState<'single' | 'compare'>('single')
  const [provider, setProvider] = useState<AIProviderId>('chatgpt')
  const [providers, setProviders] = useState<AIProviderId[]>(['chatgpt', 'claude'])
  const [instruction, setInstruction] = useState(seed.instruction)
  const [contexts, setContexts] = useState(seed.contexts)
  const generated = useMemo(() => formatContextPrompt(instruction, contexts), [instruction, contexts])
  const [prompt, setPrompt] = useState(generated)
  const [edited, setEdited] = useState(false)
  const [stale, setStale] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const instructionRef = useRef<HTMLTextAreaElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  useEffect(() => {
    if (!edited) setPrompt(generated)
    else setStale(prompt !== generated)
  }, [edited, generated, prompt])

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    instructionRef.current?.focus()
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)'))
      if (!focusable.length) return
      const index = focusable.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index >= focusable.length - 1 ? 0 : index + 1)
      event.preventDefault(); focusable[next].focus()
    }
    window.addEventListener('keydown', keydown)
    return () => { window.removeEventListener('keydown', keydown); previouslyFocused?.focus() }
  }, [])

  const toggleContext = (id: string): void => setContexts((items) => items.map((item) => item.id === id ? { ...item, enabled: !item.enabled } : item))
  const toggleProvider = (id: AIProviderId): void => setProviders((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id])
  const valid = prompt.trim().length > 0 && prompt.length <= 20_000
  const compareValid = valid && providers.length >= 2 && providers.length <= 5
  const enabledCount = contexts.filter((item) => item.enabled).length

  return <div className="modal-backdrop ask-ai-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={dialogRef} className="modal ask-ai-composer" role="dialog" aria-modal="true" aria-labelledby="ask-ai-title" aria-describedby="ask-ai-disclosure">
      <header><div><span className="eyebrow">Ask AI</span><h2 id="ask-ai-title">Review the prompt</h2></div><button className="icon-button" aria-label="Close Ask AI composer" onClick={onClose}><X size={16}/></button></header>
      <div className="composer-mode" role="group" aria-label="Delivery mode"><button aria-pressed={mode === 'single'} className={mode === 'single' ? 'active' : ''} onClick={() => setMode('single')}>Single provider</button><button aria-pressed={mode === 'compare'} className={mode === 'compare' ? 'active' : ''} onClick={() => setMode('compare')}>Compare providers</button></div>
      <label className="composer-instruction">Instruction<textarea ref={instructionRef} value={instruction} maxLength={20_000} onChange={(event) => setInstruction(event.target.value)} /></label>
      <section className="composer-context" aria-label="Prompt context"><div className="section-heading"><strong>Context</strong><div><span>{enabledCount} selected</span><button disabled={enabledCount === contexts.length} onClick={() => setContexts((items) => items.map((item) => ({ ...item, enabled: true })))}>All</button><button disabled={enabledCount === 0} onClick={() => setContexts((items) => items.map((item) => ({ ...item, enabled: false })))}>None</button></div></div>{contexts.map((item) => <label key={item.id} className="context-option"><input type="checkbox" checked={item.enabled} onChange={() => toggleContext(item.id)}/><span><strong>{item.label}</strong>{(item.documentName || item.pageNumber) && <small>{item.documentName}{item.pageNumber ? ` · page ${item.pageNumber}` : ''}</small>}<em title={item.text}>{item.text}</em></span></label>)}</section>
      <label className="composer-prompt">Final prompt<textarea aria-label="Final prompt" value={prompt} onChange={(event) => { setPrompt(event.target.value); setEdited(event.target.value !== generated); setStale(event.target.value !== generated) }}/></label>
      <div className="composer-prompt-meta"><span className={prompt.length > 20_000 ? 'error-text' : ''}>{prompt.length.toLocaleString()} / 20,000</span>{edited && <span>Manually edited</span>}{stale && <button onClick={() => { setPrompt(generated); setEdited(false); setStale(false) }}>Rebuild from context</button>}</div>
      {mode === 'single' ? <div className="composer-delivery"><AIProviderSelect value={provider} onChange={setProvider}/><div className="modal-actions"><button disabled={!valid} onClick={() => onSingle(provider, 'draft', prompt, contexts, edited)}>Insert draft</button><button className="primary-button" disabled={!valid} onClick={() => onSingle(provider, 'send', prompt, contexts, edited)}>Send now</button></div></div> : <div className="composer-delivery"><fieldset><legend>Providers</legend>{AI_PROVIDERS.map((item) => <label key={item.id}><input type="checkbox" checked={providers.includes(item.id)} onChange={() => toggleProvider(item.id)}/>{item.name}</label>)}</fieldset><div className="comparison-submit"><small>{providers.length < 2 ? 'Choose at least two providers.' : `${providers.length} providers selected`}</small><div className="modal-actions"><button onClick={onClose}>Cancel</button><button className="primary-button" disabled={!compareValid} onClick={() => onCompare(providers, prompt, contexts, edited)}>{compareValid ? `Send to ${providers.length} providers` : 'Send comparison'}</button></div></div></div>}
      <p id="ask-ai-disclosure" className="composer-disclosure">The prompt will be sent to the chosen provider websites under their account and privacy terms.</p>
    </div>
  </div>
}
