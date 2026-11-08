import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DiffView } from './DiffView'
import diffCss from './DiffView.module.css?raw'

const DIFF = [
  '--- ~/.cursor/skills/code-review/SKILL.md',
  '+++ ~/.cursor/skills/code-review/SKILL.md',
  '@@ -1,2 +1,2 @@',
  '-was',
  '+is',
].join('\n')

describe('DiffView wrapping', () => {
  it('renders blank gutters for input-only lines and numbers real hunks', () => {
    const markup = renderToStaticMarkup(<DiffView diff={'-old\n+new\n@@ -5 +7 @@\n-before\n+after'} options={false} />)
    const rows = [...markup.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map(match => [...match[1]!.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(cell => cell[1]))
    expect(rows[0]?.slice(0, 2)).toEqual(['', ''])
    expect(rows[1]?.slice(0, 2)).toEqual(['', ''])
    expect(rows.at(-2)?.slice(0, 2)).toEqual(['5', ''])
    expect(rows.at(-1)?.slice(0, 2)).toEqual(['', '7'])
  })
  it('wraps by default in every pane', () => {
    expect(renderToStaticMarkup(<DiffView diff={DIFF} />)).toContain('data-wrap')
  })

  it('allows an explicit unwrapped view', () => {
    expect(renderToStaticMarkup(<DiffView diff={DIFF} wrap={false} />)).not.toContain('data-wrap')
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
      rows(renderToStaticMarkup(<DiffView diff={DIFF} wrap={false} />)),
    )
  })
})

it('keeps patch rows horizontally contained by their own scroll box', () => {
  expect(diffCss).toMatch(/\.scroll\s*\{[^}]*overflow-x:\s*auto/s)
})
