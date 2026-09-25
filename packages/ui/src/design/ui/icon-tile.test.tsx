import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { IconTile } from './icon-tile'

it("grounds a listing's own colour, with the accent's ink on it", () => {
  const markup = renderToStaticMarkup(<IconTile size="xs" color="#7a5af8">F</IconTile>)
  expect(markup).toContain('data-color')
  expect(markup).toContain('bg-(--tile-color)')
  expect(markup).toContain('text-(--hd-accent-foreground)')
  expect(markup).toContain('--tile-color:#7a5af8')
  // Not the neutral ground a tile without a colour takes.
  expect(markup).not.toContain('bg-(--hd-muted)')
})

it('keeps the neutral soft ground when no colour is given', () => {
  const markup = renderToStaticMarkup(<IconTile size="xs">F</IconTile>)
  expect(markup).not.toContain('data-color')
  expect(markup).not.toContain('--tile-color')
  expect(markup).toContain('bg-(--hd-muted)')
})

it("crops a listing's logo to the tile's corner", () => {
  const markup = renderToStaticMarkup(<IconTile size="xs"><img src="data:," alt="" /></IconTile>)
  expect(markup).toContain('overflow-hidden')
  expect(markup).toContain('[&amp;&gt;img]:size-full')
})
