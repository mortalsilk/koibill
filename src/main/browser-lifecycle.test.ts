/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('native browser view lifecycle', () => {
  it('hides browser views without detaching their Chromium surfaces', () => {
    const source = readFileSync(new URL('./browser-tabs.ts', import.meta.url), 'utf8')
    const detachMethod = source.slice(source.indexOf('private detachAttachedView'), source.indexOf('private mountView'))
    expect(detachMethod).toContain('setVisible(false)')
    expect(detachMethod).not.toContain('removeChildView')
  })

  it('reorders the active mounted view and schedules a second repaint', () => {
    const source = readFileSync(new URL('./browser-tabs.ts', import.meta.url), 'utf8')
    const presentMethod = source.slice(source.indexOf('private presentView'), source.indexOf('private detachAttachedView'))
    expect(presentMethod).toContain('this.mountView(view, true)')
    expect(presentMethod).toContain('setImmediate')
    expect(presentMethod.match(/invalidate\(\)/gu)).toHaveLength(2)
  })

  it('offers selected browser text to graph notes without exposing a preload', () => {
    const source = readFileSync(new URL('./browser-tabs.ts', import.meta.url), 'utf8')
    expect(source).toContain("view.webContents.on('context-menu'")
    expect(source).toContain("label: 'Append to graph'")
    expect(source).toContain("kind: aiProvider ? 'ai' : 'web'")
    expect(source).toContain('provider: aiProvider?.id')
  })
})
