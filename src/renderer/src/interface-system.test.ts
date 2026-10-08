import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

describe('koibill interface system', () => {
  it('defines the shared spacing, control, motion, and layer tokens', () => {
    for (const token of ['--space-1', '--space-5', '--control', '--radius', '--transition-fast', '--layer-menu', '--layer-dialog']) {
      expect(css).toContain(`${token}:`)
    }
  })

  it('supports reduced motion and coarse pointer targets', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('@media (pointer: coarse)')
    expect(css).toMatch(/min-(?:width|height): 44px/)
  })

  it('keeps application surfaces on monochrome semantic tokens', () => {
    expect(css).toContain('--background: #ffffff')
    expect(css).toContain('--accent: #000000')
    expect(css).not.toMatch(/(?:workspace-bar|reader-controls|right-mode-switcher)[^{]*\{[^}]*gradient/s)
  })
})
