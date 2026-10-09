import { describe, expect, it } from 'vitest'

import css from './FlowStart.module.css?raw'
import source from './FlowStart.tsx?raw'

const body = (selector: string): string => {
  const start = css.indexOf(`${selector} {`)
  expect(start, `${selector} is missing from FlowStart.module.css`).toBeGreaterThan(-1)
  return css.slice(start, css.indexOf('}', start))
}

describe('New Team seat controls', () => {
  it('ellipsizes a long selected agent name while its control carries the full title', () => {
    expect(source).toContain('className={styles.agentSelect}')
    expect(source).toContain('title={selectedRuntime?.presentation.name}')
    expect(body('.agentSelect select')).toMatch(/text-overflow:\s*ellipsis/)
    expect(body('.roleControls')).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(body('.agentSelect')).toMatch(/grid-column:\s*1\s*\/\s*-1/)
  })

  it('keeps the review chip at the standard gap from its label', () => {
    expect(source).toContain('className={styles.roleTitle}')
    expect(body('.roleTitle')).toMatch(/gap:\s*var\(--hd-space-2\)/)
  })
})
