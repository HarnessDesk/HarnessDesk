import { expect, it } from 'vitest'
import css from '../primitives/Banner.module.css?raw'
import composer from './composer.tsx?raw'

it('uses the composer plate in flow and reserves the floating shadow for toasts', () => {
  for (const token of ['--hd-card', '--hd-radius-lg', '--hd-border-emphasis', '--hd-composer-shell-shadow']) {
    expect(composer).toContain(token)
    expect(css).toContain(token)
  }
  expect(css).toMatch(/\.banner\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--hd-border-emphasis\),\s*var\(--hd-composer-shell-shadow\)/s)
  const floating = css.match(/\.banner\[data-floating\]\s*\{([^}]+)\}/)?.[1]
  expect(floating).toContain('var(--hd-shadow-notice)')
  expect(css.match(/var\(--hd-shadow-notice\)/g)).toHaveLength(1)
})
