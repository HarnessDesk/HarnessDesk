import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { ConversationEmptyState } from './ConversationEmptyState'
import {
  GitHistoryActionBar,
  GitHistoryCommitDetail,
  GitHistoryCommitDetailHeader,
  GitHistoryDiffViewport,
  GitHistoryFilters,
  GitHistoryInlinePatch,
  GitHistoryTableHeader,
} from './GitHistory'

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

it('owns the repository history bars and commit-detail insets', () => {
  act(() => root.render(
    <>
      <GitHistoryActionBar>Actions</GitHistoryActionBar>
      <GitHistoryFilters>Filters</GitHistoryFilters>
      <GitHistoryTableHeader>Columns</GitHistoryTableHeader>
      <GitHistoryCommitDetail>
        <GitHistoryCommitDetailHeader>Commit</GitHistoryCommitDetailHeader>
        <GitHistoryDiffViewport>Diff</GitHistoryDiffViewport>
      <GitHistoryInlinePatch>Inline patch</GitHistoryInlinePatch>
      </GitHistoryCommitDetail>
      <ConversationEmptyState>Nothing to show</ConversationEmptyState>
    </>,
  ))

  expect(container.querySelector('[data-slot="git-history-action-bar"]')?.textContent).toBe('Actions')
  expect(container.querySelector('[data-slot="git-history-filters"]')?.textContent).toBe('Filters')
  expect(container.querySelector('[data-slot="git-history-table-header"]')?.textContent).toBe('Columns')
  expect(container.querySelector('[data-slot="git-history-commit-detail"]')?.textContent).toContain('Commit')
  expect(container.querySelector('[data-slot="git-history-commit-detail-header"]')?.textContent).toBe('Commit')
  expect(container.querySelector('[data-slot="git-history-diff-viewport"]')?.textContent).toBe('Diff')
  // The inline patch is the system's row detail, set on the file list's inner line.
  const patch = container.querySelector<HTMLElement>('[data-slot="list-row-detail"]')
  expect(patch?.textContent).toBe('Inline patch')
  expect(patch?.hasAttribute('data-inset')).toBe(true)
  expect(container.querySelector('[data-slot="conversation-empty-state"]')?.textContent).toBe('Nothing to show')
})
