/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('browser pane layout', () => {
  it('pins the browser surface to the flexible content row', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
    expect(css).toContain('grid-template-areas: "tabs" "toolbar" "notices" "content"')
    expect(css).toContain('.browser-pane > .browser-content { grid-area: content; }')
    expect(css).not.toContain('.browser-notices:empty { display: none; }')
  })

  it('keeps hidden browser, notes, and graph surfaces mounted', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
    expect(css).toContain('.right-surface.hidden { z-index: 1; visibility: hidden; pointer-events: none; }')
    expect(css).not.toMatch(/\.right-surface\.hidden\s*\{[^}]*display:\s*none/)
    expect(css).toContain('.graph-pane')
  })
})
