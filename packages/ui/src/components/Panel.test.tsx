import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import {
  Counts,
  GroupLine,
  PanelBody,
  PanelEmpty,
  PanelFilter,
  PanelFooter,
  PanelFrame,
  PanelPill,
  PanelRow,
  PanelTools,
  RowTime,
  RunDot,
} from './Panel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('uses the shared search field for an inspector filter', () => {
  act(() => root.render(<PanelFilter value="" placeholder="Filter files" onChange={() => {}} />))
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')
  expect(input?.type).toBe('search')
  expect(input?.closest('[data-slot="search"]')).not.toBeNull()
})

it('composes the inspector roles instead of drawing them in the screen sheet', () => {
  act(() => root.render(
    <>
      <PanelFrame testId="changes-panel">
        <PanelTools><PanelPill>Refresh</PanelPill></PanelTools>
        <PanelBody>
          <GroupLine left="Today" right="3" />
          <PanelRow title="Changed file" sub="src/app.ts" selected onClick={() => {}} trail={<RowTime>10:42</RowTime>} />
          <Counts added={4} removed={2} />
          <PanelPill as="span">this week</PanelPill>
          <RunDot />
          <PanelEmpty>No changes</PanelEmpty>
        </PanelBody>
        <PanelFooter left="1 file" right="Ready" />
      </PanelFrame>
    </>,
  ))

  expect(container.querySelector('[data-slot="inspector-panel"]')?.getAttribute('data-testid')).toBe('changes-panel')
  expect(container.querySelector('[data-slot="inspector-tools"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="inspector-body"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="inspector-group"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="inspector-row"]')?.hasAttribute('data-selected')).toBe(true)
  expect(container.querySelector('[data-slot="change-stats"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="chip-words"]')?.textContent).toBe('this week')
  expect(container.querySelector('[data-slot="dot"]')?.hasAttribute('data-pulse')).toBe(true)
  expect(container.querySelector('[data-slot="inspector-empty"]')?.textContent).toBe('No changes')
  const footer = container.querySelector('[data-slot="inspector-footer"]')
  expect(footer?.getAttribute('data-slot')).toBe('inspector-footer')
  expect([...(footer?.querySelectorAll(':scope > [data-slot="text"]') ?? [])].map((node) => [node.getAttribute('data-role'), node.textContent]))
    .toEqual([['meta', '1 file'], ['meta', 'Ready']])
})
