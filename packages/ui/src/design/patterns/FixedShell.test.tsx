import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FixedShell } from './FixedShell'
import css from './FixedShell.module.css?raw'

it('has an independent rail below the shared bar and a full-height pane', () => {
  const html = renderToStaticMarkup(<FixedShell viewportWidth={1440} left="Left" top="Bar" main="Main" rail="Cards" right="Tool" bottom={null}
    leftFloating={false} panelFloating={false} leftOpen rightOpen bottomOpen={false} railOpen railFloating={false} paneExpanded={false} />)
  expect(html).toContain('data-frame-region="rail"')
  expect(html).toContain('data-rail-open="true"')
  expect(css).toContain("'left top top right' 'left main rail right'")
})

it('swaps the same region mounts and gives a floating rail the decided sheet geometry', () => {
  expect(css).toMatch(/data-pane-expanded='true'[\s\S]*grid-area:\s*right/)
  const html = renderToStaticMarkup(<FixedShell viewportWidth={720} left={null} top={null} main={null} rail="Cards" right={null} bottom={null} leftFloating panelFloating={false} leftOpen={false} rightOpen={false} bottomOpen={false} railOpen railFloating />)
  expect(html).toContain('rounded-(--hd-radius-matted)')
  expect(html).toContain('shadow-(--hd-shadow-lg)')
  expect(css).toMatch(/data-panel-floats='true'[\s\S]*\.main[\s\S]*visibility:\s*hidden/)
})

it('contains a floating cards rail within the main grid area beside an open tool', () => {
  const floating = css.match(/\.shell\[data-rail-floats='true'\] \.rail \{([^}]+)\}/)?.[1]
  // Grid-area containment follows the live sidebar/panel drag projection.
  // At 1128px, the 256px sidebar and 380px Details leave a 492px main:
  // a sheet measured against the shell would cover the Details instead.
  expect(floating).toMatch(/grid-area:\s*main/)
  expect(floating).toMatch(/top:\s*var\(--hd-rail-inset\)/)
  expect(floating).toMatch(/right:\s*var\(--hd-rail-inset\)/)
  expect(floating).toMatch(/width:\s*min\(var\(--frame-rail-width\), calc\(100% - var\(--hd-rail-inset\) \* 2\)\)/)
  expect(css).toMatch(/data-pane-expanded='true'\]\[data-rail-floats='true'\] \.rail \{ grid-area: right;/)
})
