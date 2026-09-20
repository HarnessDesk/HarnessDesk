import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { ListRow } from './list-row'

it('lets an earned sentence wrap instead of cutting it into a caption', () => {
  const markup = renderToStaticMarkup(
    <ListRow
      title="Agent A"
      subtitle="The executable did not answer, so a session sent to it would not start."
      wrapSubtitle
    />,
  )

  expect(markup).toContain('data-wrap-subtitle=""')
  expect(markup).toContain('whitespace-normal')
  expect(markup).toContain('[overflow-wrap:anywhere]')
})

it('keeps multiple lead marks beside rather than over one another', () => {
  const markup = renderToStaticMarkup(
    <ListRow lead={<><span>choice</span><span>agent</span></>} title="Session" />,
  )

  expect(markup).toContain('data-slot="list-row-lead"')
  expect(markup).toContain('inline-flex')
  expect(markup).toContain('gap-2')
})
