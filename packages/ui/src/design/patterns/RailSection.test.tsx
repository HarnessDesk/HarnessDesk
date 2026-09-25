import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { AppWindowRailScroll, AppWindowRailTop } from './AppWindow'
import { RailSection } from './DockPanel'

const classOf = (markup: string): string[] => /class="([^"]*)"/.exec(markup)?.[1]?.split(' ') ?? []

it('holds a compact rail on the bars’ gutter with a short head step and a long list tail', () => {
  const head = classOf(renderToStaticMarkup(<RailSection stretch="head">places</RailSection>))
  expect(head).toContain('px-(--hd-bar-pad)')
  expect(head).toContain('pb-(--hd-space-1)')
  expect(head.some((one) => one.startsWith('pt-'))).toBe(false)

  const list = classOf(renderToStaticMarkup(<RailSection stretch="list">sessions</RailSection>))
  expect(list).toContain('px-(--hd-bar-pad)')
  expect(list).toContain('pt-(--hd-space-0-5)')
  expect(list).toContain('pb-3')
})

it('gives the window rail its wider gutter and longer steps, and clears the window buttons', () => {
  const top = classOf(renderToStaticMarkup(<AppWindowRailTop>back</AppWindowRailTop>))
  expect(top).toEqual(expect.arrayContaining(['px-3', 'pt-(--hd-titlebar-height)', 'pb-2']))

  const scroll = classOf(renderToStaticMarkup(<AppWindowRailScroll>pages</AppWindowRailScroll>))
  expect(scroll).toEqual(expect.arrayContaining(['px-3', 'pt-1.5', 'pb-3']))
  expect(scroll).not.toContain('pt-(--hd-titlebar-height)')
})

it('is one part under both rails', () => {
  for (const markup of [
    renderToStaticMarkup(<RailSection stretch="head">a</RailSection>),
    renderToStaticMarkup(<AppWindowRailTop>b</AppWindowRailTop>),
    renderToStaticMarkup(<AppWindowRailScroll>c</AppWindowRailScroll>),
  ]) expect(markup).toContain('data-slot="rail-section"')
})

it('opens a head that sits under a bar’s rule with the step it closes with, so its first row never meets the line', () => {
  const ruled = renderToStaticMarkup(<RailSection stretch="head" ruled>places</RailSection>)
  expect(ruled).toContain('data-ruled')
  expect(classOf(ruled)).toEqual(expect.arrayContaining(['pt-(--hd-space-1)', 'pb-(--hd-space-1)']))
  // Only a head is ever under a bar; a list is under its label.
  const list = renderToStaticMarkup(<RailSection stretch="list" ruled>sessions</RailSection>)
  expect(list).not.toContain('data-ruled')
  expect(classOf(list)).not.toContain('pt-(--hd-space-1)')
})
