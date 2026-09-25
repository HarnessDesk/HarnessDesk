import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { Alert } from './alert'

it('offers the soft neutral plate used for ambient hand-offs', () => {
  const markup = renderToStaticMarkup(<Alert tone="neutral" variant="soft">Ready</Alert>)
  expect(markup).toContain('data-variant="soft"')
  expect(markup).toContain('bg-(--hd-muted)')
  expect(markup).toContain('border-(--hd-border-strong)')
})

it('says which tone it is in, so a reader can ask the alert rather than its classes', () => {
  expect(renderToStaticMarkup(<Alert tone="danger">Failed</Alert>)).toContain('data-tone="danger"')
  expect(renderToStaticMarkup(<Alert>Ready</Alert>)).toContain('data-tone="neutral"')
})

it('sets a neutral alert’s title in the primary ink, whatever ink the alert stands in', () => {
  const markup = renderToStaticMarkup(<Alert tone="neutral">Ready</Alert>)
  expect(markup).toContain('[&amp;_[data-slot=alert-title]]:text-(--hd-foreground)')
  // A toned alert's ink is its tone's business, not this rule's.
  expect(renderToStaticMarkup(<Alert tone="warning">Careful</Alert>)).not.toContain('data-slot=alert-title]]:text-(--hd-foreground)')
})
