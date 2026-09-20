import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { Alert } from './alert'

it('offers the soft neutral plate used for ambient hand-offs', () => {
  const markup = renderToStaticMarkup(<Alert tone="neutral" variant="soft">Ready</Alert>)
  expect(markup).toContain('data-variant="soft"')
  expect(markup).toContain('bg-(--hd-muted)')
  expect(markup).toContain('border-(--hd-border-strong)')
})
