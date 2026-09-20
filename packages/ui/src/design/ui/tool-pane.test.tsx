import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import {
  ToolPane,
  ToolPaneActivity,
  ToolPaneActivityMark,
  ToolPaneBar,
  ToolPaneBody,
  ToolPaneDocumentTab,
  ToolPaneEmptyState,
  ToolPaneFooter,
  ToolPaneHeader,
  ToolPaneHeaderDivider,
  ToolPaneMessage,
  ToolPaneNotice,
  ToolPaneReading,
  ToolPaneTabIcon,
  ToolPaneTabViewport,
  ToolPaneToolGroup,
} from './tool-pane'

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

it('owns the integrated pane frame and the window-corner header', () => {
  act(() => root.render(
    <ToolPane variant="integrated">
      <ToolPaneHeader title="Editor" subtitle="/work/app.ts" variant="window" corner />
      <ToolPaneBody bleed>body</ToolPaneBody>
    </ToolPane>,
  ))

  expect(container.querySelector('[data-slot="tool-pane"]')?.getAttribute('data-variant')).toBe('integrated')
  expect(container.querySelector('[data-slot="tool-pane-header"]')?.getAttribute('data-variant')).toBe('window')
  expect(container.querySelector('[data-slot="tool-pane-header"]')?.hasAttribute('data-corner')).toBe(true)
  expect(container.querySelector('[data-slot="tool-pane-body"]')?.hasAttribute('data-bleed')).toBe(true)
})

it('owns the bars, messages, document tabs, activity and footer anatomy', () => {
  act(() => root.render(
    <ToolPane>
      <ToolPaneHeader title="Browser" lead={<span>Tabs</span>} actions={<button>Reload</button>} />
      <ToolPaneHeaderDivider />
      <ToolPaneBar variant="address">example.com</ToolPaneBar>
      <ToolPaneNotice tone="danger" placement="bottom">Page failed</ToolPaneNotice>
      <ToolPaneMessage>Waiting</ToolPaneMessage>
      <ToolPaneEmptyState title="No page" description="Open an address." />
      <ToolPaneTabViewport edges={{ start: true, end: true }}>
        <ToolPaneDocumentTab data-active>
          <ToolPaneTabIcon src="/icon.png" alt="" />
          Home
        </ToolPaneDocumentTab>
      </ToolPaneTabViewport>
      <ToolPaneActivity><ToolPaneActivityMark>1</ToolPaneActivityMark>Running</ToolPaneActivity>
      <ToolPaneToolGroup>Tools</ToolPaneToolGroup>
      <ToolPaneReading>Reading</ToolPaneReading>
      <ToolPaneFooter>Connected</ToolPaneFooter>
    </ToolPane>,
  ))

  for (const slot of [
    'tool-pane-header-divider',
    'tool-pane-bar',
    'tool-pane-notice',
    'tool-pane-message',
    'tool-pane-empty',
    'tool-pane-tab-viewport',
    'tool-pane-document-tab',
    'tool-pane-tab-icon',
    'tool-pane-activity',
    'tool-pane-activity-mark',
    'tool-pane-tool-group',
    'tool-pane-reading',
    'tool-pane-footer',
  ]) expect(container.querySelector(`[data-slot="${slot}"]`)).not.toBeNull()
  expect(container.querySelector('[data-slot="tool-pane-tab-viewport"]')?.hasAttribute('data-more-start')).toBe(true)
  expect(container.querySelector('[data-slot="tool-pane-tab-viewport"]')?.hasAttribute('data-more-end')).toBe(true)
  expect(container.querySelector('[data-slot="tool-pane-notice"]')?.getAttribute('data-placement')).toBe('bottom')
  expect(container.querySelector('button')?.textContent).toBe('Reload')
})
