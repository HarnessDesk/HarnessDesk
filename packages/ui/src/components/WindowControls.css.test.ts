import { expect, it } from 'vitest'
import css from './WindowControls.module.css?raw'

it('never folds the lead by a destination header or container width', () => {
  // The frame window state, tested in WindowControls.frame.test.tsx, owns it.
  expect(css).not.toContain('@container')
  expect(css).not.toMatch(/display:\s*none/)
})
