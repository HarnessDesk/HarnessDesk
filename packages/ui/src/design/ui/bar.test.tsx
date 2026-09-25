import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { Bar } from './bar'

const classOf = (markup: string): string[] => /class="([^"]*)"/.exec(markup)?.[1]?.split(' ') ?? []

it('stands at the window’s bar height, its contents centred on the bar’s padding', () => {
  const bar = classOf(renderToStaticMarkup(<Bar>tools</Bar>))
  expect(bar).toEqual(expect.arrayContaining(['h-(--hd-bar-h)', 'items-center', 'pr-(--hd-bar-pad)', 'pl-(--hd-bar-pad)']))
  expect(bar.some((one) => one.startsWith('border'))).toBe(false)
})

it('draws its rule on the edge it names, and only there', () => {
  const top = classOf(renderToStaticMarkup(<Bar rule="top">foot</Bar>))
  expect(top).toContain('border-t')
  expect(top).not.toContain('border-b')
  const bottom = classOf(renderToStaticMarkup(<Bar rule="bottom">head</Bar>))
  expect(bottom).toContain('border-b')
  expect(bottom).not.toContain('border-t')
})

it('starts words on the rows’ ink line when inset is ink', () => {
  const ink = classOf(renderToStaticMarkup(<Bar inset="ink">HarnessDesk</Bar>))
  expect(ink).toContain('pl-(--hd-bar-ink)')
  expect(ink).not.toContain('pl-(--hd-bar-pad)')
})

it('clears the window buttons from the corner, on whichever inset it keeps', () => {
  expect(classOf(renderToStaticMarkup(<Bar corner>lights</Bar>))).toContain('pl-[max(var(--hd-bar-pad),var(--titlebar-inset,0px))]')
  expect(classOf(renderToStaticMarkup(<Bar corner inset="ink">lights</Bar>))).toContain('pl-[max(var(--hd-bar-ink),var(--titlebar-inset,0px))]')
})

it('is a header when it names what is under it, and a plain box otherwise', () => {
  expect(renderToStaticMarkup(<Bar>tools</Bar>)).toMatch(/^<div data-slot="bar"/)
  const head = renderToStaticMarkup(<Bar as="header" rule="bottom">Checkout rewrite</Bar>)
  expect(head).toMatch(/^<header data-slot="bar"/)
  expect(classOf(head)).toContain('h-(--hd-bar-h)')
})
