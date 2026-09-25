import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import {
  ToolPaneGuest,
  ToolPaneStage,
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

it('grounds a guest page on the white a page assumes, whatever the theme', () => {
  const guest = renderToStaticMarkup(<ToolPaneGuest title="page" src="about:blank" />)
  expect(guest).toMatch(/^<iframe/)
  expect(guest).toContain('bg-(--hd-external-canvas)')
  expect(guest).not.toContain('bg-(--hd-card)')
  expect(guest).not.toContain('data-framed')
  expect(guest).not.toContain('shadow-(--hd-hairline)')

  const framed = renderToStaticMarkup(<ToolPaneGuest as="webview" framed src="about:blank" />)
  expect(framed).toMatch(/^<webview/)
  expect(framed).toContain('data-framed')
  expect(framed).toContain('rounded-(--hd-radius-sm)')
  expect(framed).toContain('shadow-(--hd-hairline)')
})

it('sets a device-sized guest on the muted stage, and leaves an unframed stage bare', () => {
  const bare = renderToStaticMarkup(<ToolPaneStage>guest</ToolPaneStage>)
  expect(bare).not.toContain('bg-(--hd-muted)')
  expect(bare).not.toContain('data-framed')

  const framed = renderToStaticMarkup(<ToolPaneStage framed>guest</ToolPaneStage>)
  expect(framed).toContain('data-framed')
  expect(framed).toContain('bg-(--hd-muted)')
  expect(framed).toContain('justify-center')
})

it('stands a bar of the tool’s own controls on the find bar’s rung as a floor, and wraps them, so a narrow row grows instead of clipping', () => {
  const tools = renderToStaticMarkup(<ToolPaneBar variant="tools" role="toolbar" aria-label="Repository actions">verbs</ToolPaneBar>)
  expect(tools).toContain('role="toolbar"')
  expect(tools).toContain('data-variant="tools"')
  // A floor, not a height: the caller's controls may take a second line.
  expect(tools).toContain('min-h-9')
  expect(tools).not.toMatch(/(?<![\w-])h-9(?![\w-])/)
  // It wraps: a narrow pane's controls take a second line and the bar grows.
  expect(tools).toMatch(/(?<![\w-])flex-wrap(?![\w-])/)
  // The same rung, edge and ground as the find bar it stands beside.
  const find = renderToStaticMarkup(<ToolPaneBar variant="find">find</ToolPaneBar>)
  expect(find).toMatch(/(?<![\w-])h-9(?![\w-])/)
  for (const bar of [tools, find]) {
    expect(bar).toContain('border-b')
    expect(bar).toContain('bg-(--hd-card)')
  }
})
