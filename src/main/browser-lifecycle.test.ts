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

  it('captures selected provider answers only for the active comparison', () => {
    const source = readFileSync(new URL('./browser-tabs.ts', import.meta.url), 'utf8')
    expect(source).toContain("label: 'Save selection to active comparison'")
    expect(source).toContain("this.activeComparison?.providers.includes(aiProvider.id)")
    expect(source).toContain("'ask-ai:comparison-excerpt'")
    expect(source).toContain('if (!request.linkTargets.length && !request.comparisonId) return')
  })

  it('keeps background comparison deliveries responsive, then restores throttling', () => {
    const source = readFileSync(new URL('./browser-tabs.ts', import.meta.url), 'utf8')
    const delivery = source.slice(source.indexOf('private queueDelivery'), source.indexOf('private registerPendingLink'))
    expect(delivery).toContain('setBackgroundThrottling(false)')
    expect(delivery).toContain('setBackgroundThrottling(true)')
  })

  it('bounds automatic recovery and replaces crashed browser surfaces', () => {
    const source = readFileSync(new URL('./browser-tabs.ts', import.meta.url), 'utf8')
    const configure = source.slice(source.indexOf('private configureView'), source.indexOf('private attachView'))
    const recovery = source.slice(source.indexOf('private scheduleRecovery'), source.indexOf('private failAsk'))
    expect(configure).toContain("on('render-process-gone'")
    expect(configure).toContain('this.scheduleRecovery(tab, 600, true)')
    expect(recovery).toContain('tab.recoveryAttempts >= 2')
    expect(recovery).toContain('tab.view = undefined')
  })
})
