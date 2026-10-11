import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { Input } from './input'

it('provides a borderless bare field with token ink and a token-sized box', () => {
  const markup = renderToStaticMarkup(<Input type="search" variant="bare" controlSize="bare" aria-label="Search palette" />)
  expect(markup).toContain('data-variant="bare"')
  expect(markup).toContain('data-size="bare"')
  expect(markup).toContain('border-0')
  expect(markup).toContain('text-(--hd-foreground)')
})
