import { describe, expect, it } from 'vitest'

import css from './FlowStart.module.css?raw'
import source from './FlowStart.tsx?raw'

const body = (selector: string): string => {
  const start = css.indexOf(`${selector} {`)
  expect(start, `${selector} is missing from FlowStart.module.css`).toBeGreaterThan(-1)
  return css.slice(start, css.indexOf('}', start))
}

describe('New Team seat controls', () => {
  it('ellipsizes the runtime and model summary while its configuration control carries the full title', () => {
    expect(source).toContain('<Popover fullWidth aria-label={`Configure ${label}`} title={summary}')
    expect(source).toContain('<Text role="row" truncate>{summary}</Text>')
    // A bounded control can shrink with its Row; shared Text owns the ellipsis.
    expect(body('.roleControls')).toMatch(/min-width:\s*0/)
    expect(body('.roleControls')).toMatch(/max-width:\s*100%/)
  })

  it('keeps the review chip at the standard gap from its label', () => {
    expect(source).toContain('className={styles.roleTitle}')
    expect(body('.roleTitle')).toMatch(/gap:\s*var\(--hd-space-2\)/)
  })
})
