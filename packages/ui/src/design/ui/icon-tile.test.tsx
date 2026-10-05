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

it('says which identity or which tone it wears, so a reader can ask the tile rather than its classes', () => {
  const tinted = renderToStaticMarkup(<IconTile tint="violet">F</IconTile>)
  expect(tinted).toContain('data-tint="violet"')
  expect(tinted).not.toContain('data-tone')
  const toned = renderToStaticMarkup(<IconTile tone="warning">F</IconTile>)
  expect(toned).toContain('data-tone="warning"')
  expect(toned).not.toContain('data-tint')
  // A tile with neither is the neutral one.
  expect(renderToStaticMarkup(<IconTile>F</IconTile>)).toContain('data-tone="neutral"')
  // A listing's own colour is neither an identity nor a judgement.
  const coloured = renderToStaticMarkup(<IconTile color="#7a5af8">F</IconTile>)
  expect(coloured).not.toContain('data-tint')
  expect(coloured).not.toContain('data-tone')
})

it('fills a tinted face and keeps other tinted shapes on the soft wash', () => {
  const face = renderToStaticMarkup(<IconTile shape="face" tint="violet">A</IconTile>)
  expect(face).toContain('bg-(--hd-tint-violet-ink)')
  expect(face).toContain('text-(--hd-accent-foreground)')
  const square = renderToStaticMarkup(<IconTile shape="square" tint="violet">A</IconTile>)
  expect(square).toContain('bg-(--hd-tint-violet-fill)')
  expect(square).toContain('text-(--hd-tint-violet-ink)')
  const round = renderToStaticMarkup(<IconTile shape="round" tint="violet">A</IconTile>)
  expect(round).toContain('bg-(--hd-tint-violet-fill)')
})

it('declares the shape it drew, and a caller cannot say otherwise', () => {
  // The faces rule reads `data-shape` to find everyone drawn on screen, so it
  // has to be the tile's own word: a spread attribute that replaced it would
  // hide a face from both the face check and the agent-mark check.
  expect(renderToStaticMarkup(<IconTile shape="face">A</IconTile>)).toContain('data-shape="face"')
  expect(renderToStaticMarkup(<IconTile shape="round">A</IconTile>)).toContain('data-shape="round"')
  expect(renderToStaticMarkup(<IconTile>A</IconTile>)).toContain('data-shape="square"')
  const overridden = renderToStaticMarkup(<IconTile shape="face" data-shape="square">A</IconTile>)
  expect(overridden).toContain('data-shape="face"')
  expect(overridden).not.toContain('data-shape="square"')
})

it('has a 20px stack face step, without a screen overriding its size', () => {
  expect(renderToStaticMarkup(<IconTile size="stack" shape="face">A</IconTile>)).toContain('size-(--hd-space-5)')
})
