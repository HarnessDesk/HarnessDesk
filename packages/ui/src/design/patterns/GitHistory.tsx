import { forwardRef, type ComponentProps } from 'react'

import { cn } from '@/lib/utils'
import { Toolbar } from '../ui/section'
import styles from './GitHistory.module.css'

/**
 * The chrome around a repository's history, separate from the graph and
 * patches that are the repository's content. These are not generic toolbars:
 * their compact action row, filtering band, table heading and resizable commit
 * detail only make sense together in a history viewer.
 */
const GitHistoryActionBar = ({ className, ...props }: ComponentProps<typeof Toolbar>) => (
  <Toolbar data-slot="git-history-action-bar" className={cn('h-(--hd-history-action-h) gap-0.5 px-2', styles.actionBar, className)} {...props} />
)

const GitHistoryFilters = ({ className, ...props }: ComponentProps<typeof Toolbar>) => (
  <Toolbar data-slot="git-history-filters" className={cn('min-h-(--hd-history-filter-min-h) px-2.5 py-0.5', styles.filters, className)} {...props} />
)

const GitHistoryTableHeader = ({ className, ...props }: ComponentProps<'div'>) => (
  <div data-slot="git-history-table-header" className={cn('h-(--hd-control-h-sm) pr-3', styles.tableHeader, className)} {...props} />
)

const GitHistoryCommitDetail = forwardRef<HTMLDivElement, ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} data-slot="git-history-commit-detail" className={cn('min-h-(--hd-history-detail-min-h)', className)} {...props} />
  ),
)
GitHistoryCommitDetail.displayName = 'GitHistoryCommitDetail'

const GitHistoryCommitDetailHeader = ({ className, ...props }: ComponentProps<typeof Toolbar>) => (
  <Toolbar data-slot="git-history-commit-detail-header" className={cn('gap-2 px-2.5 py-1', styles.commitDetailHeader, className)} {...props} />
)

const GitHistoryCommitFileList = ({ className, ...props }: ComponentProps<'div'>) => (
  <div data-slot="git-history-commit-file-list" className={cn('pb-2', className)} {...props} />
)

const GitHistoryDiffViewport = ({ className, ...props }: ComponentProps<'div'>) => (
  <div data-slot="git-history-diff-viewport" className={cn('min-h-0 px-3 py-2.5', styles.diffViewport, className)} {...props} />
)

const GitHistoryInlinePatch = ({ className, ...props }: ComponentProps<'div'>) => (
  <div data-slot="git-history-inline-patch" className={cn('px-3 pt-1 pb-3', className)} {...props} />
)

export {
  GitHistoryActionBar,
  GitHistoryFilters,
  GitHistoryTableHeader,
  GitHistoryCommitDetail,
  GitHistoryCommitDetailHeader,
  GitHistoryCommitFileList,
  GitHistoryDiffViewport,
  GitHistoryInlinePatch,
}
