import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { IssueMark } from './Menu'

it('shows only an exclamation mark while exposing the message on hover and to assistive technology', () => {
  const html = renderToStaticMarkup(<IssueMark message="The runtime cannot start." />)
  expect(html).toContain('data-slot="issue-mark"')
  expect(html).toContain('title="The runtime cannot start."')
  expect(html).toContain('aria-label="The runtime cannot start."')
  expect(html).not.toContain('>The runtime cannot start.<')
})

it('distinguishes an error from a warning without adding another line of text', () => {
  const html = renderToStaticMarkup(<IssueMark message="Could not start." tone="danger" />)
  expect(html).toContain('data-tone="danger"')
  expect(html).not.toContain('>Could not start.<')
})
