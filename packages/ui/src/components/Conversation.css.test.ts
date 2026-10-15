import { expect, it } from 'vitest'
import css from './Conversation.module.css?raw'
import shellCss from '../design/patterns/TopBar.module.css?raw'

// The real shell DOM and browser tests now exercise the two measured folds.
// A retained private container fold would silently compete with those rules.
it('the conversation no longer imposes private header or title folds', () => {
  expect(css).not.toContain('@container hd-header')
  expect(css).not.toMatch(/\.title\s*\{/)
  expect(css).not.toMatch(/\.header\s*\{/)
})
it('the shared shell keeps fixed controls and a title as wide as its words', () => {
  expect(shellCss).toMatch(/\.fixed\s*\{[^}]*flex:\s*none/)
  expect(shellCss).toMatch(/\.title\s*\{[^}]*flex:\s*0 1 auto/)
  expect(shellCss).toMatch(/\.title\s*\{[^}]*max-width:\s*var\(--hd-bar-title-max\)/)
  expect(shellCss).not.toMatch(/\[data-work-tool[^}]*display:\s*none/)
})
