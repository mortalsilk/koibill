import { cloneElement, isValidElement, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface PopoverProps {
  label: string
  trigger: ReactElement<{ onClick?: () => void; 'aria-expanded'?: boolean; 'aria-controls'?: string }>
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  align?: 'start' | 'end'
  className?: string
}

export function Popover({ label, trigger, children, open: controlledOpen, onOpenChange, align = 'start', className = '' }: PopoverProps): React.JSX.Element {
  const id = useId()
  const triggerRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [internalOpen, setInternalOpen] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const open = controlledOpen ?? internalOpen
  const setOpen = (next: boolean): void => { setInternalOpen(next); onOpenChange?.(next) }

  useLayoutEffect(() => {
    if (!open) return
    const update = (): void => {
      const anchor = triggerRef.current?.getBoundingClientRect()
      const panel = panelRef.current
      if (!anchor || !panel) return
      const margin = 8
      const width = panel.offsetWidth
      const height = panel.offsetHeight
      const preferredLeft = align === 'end' ? anchor.right - width : anchor.left
      const left = Math.max(margin, Math.min(window.innerWidth - width - margin, preferredLeft))
      const below = anchor.bottom + 6
      const top = below + height <= window.innerHeight - margin ? below : Math.max(margin, anchor.top - height - 6)
      setPosition({ left, top })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const frame = requestAnimationFrame(update)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [open, align])

  useLayoutEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false)
    }
    const keydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.querySelector<HTMLElement>('button')?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', keydown)
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus())
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', keydown) }
  }, [open])

  const triggerElement = isValidElement(trigger) ? cloneElement(trigger, {
    onClick: () => { trigger.props.onClick?.(); setOpen(!open) },
    'aria-expanded': open,
    'aria-controls': open ? id : undefined,
  }) : trigger

  return <>
    <span ref={triggerRef} className="ui-popover-trigger">{triggerElement}</span>
    {open && createPortal(<div ref={panelRef} id={id} role="dialog" aria-label={label} className={`ui-popover ${className}`} style={position}>{children}</div>, document.body)}
  </>
}
