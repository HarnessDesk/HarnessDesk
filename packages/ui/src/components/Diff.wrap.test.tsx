import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DiffView } from './Diff'

const DIFF = [
  '--- ~/.cursor/skills/code-review/SKILL.md',
  '+++ ~/.cursor/skills/code-review/SKILL.md',
  '@@ -1,2 +1,2 @@',
  '-was',
  '+is',
].join('\n')

/**
 * Wrapping is opt-in, and off is the right default.
 *
 * A diff read in a pane scrolls sideways, which keeps its columns straight
 * and is what every review tool does. A diff read in a *dialog* is 620px
 * wide, an eighty-column line does not fit, and the surface exists to be read
 * in full before somebody agrees to it — so the library's install preview
 * asks for wrapping and nothing else does.
 */
describe('DiffView wrapping', () => {
  it('is off unless asked for', () => {
    expect(renderToStaticMarkup(<DiffView diff={DIFF} />)).not.toContain('data-wrap')
  })

  it('marks the table when asked, which is what the stylesheet keys on', () => {
    const markup = renderToStaticMarkup(<DiffView diff={DIFF} wrap />)
    expect(markup).toContain('data-wrap')
    // On the table, not the scroller: `table-layout: fixed` and the gutter
    // width both belong to the table, and putting the hook anywhere else
    // makes them silently not apply.
    expect(markup).toMatch(/<table[^>]*data-wrap/)
  })

  it('renders the same rows either way — wrapping is presentation, not content', () => {
    const rows = (markup: string) => (markup.match(/<tr/g) ?? []).length
    expect(rows(renderToStaticMarkup(<DiffView diff={DIFF} wrap />))).toBe(
      rows(renderToStaticMarkup(<DiffView diff={DIFF} />)),
    )
  })
})
