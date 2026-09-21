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
  <Toolbar data-slot="git-history-action-bar" className={cn(styles.actionBar, className)} {...props} />
)

const GitHistoryFilters = ({ className, ...props }: ComponentProps<typeof Toolbar>) => (
  <Toolbar data-slot="git-history-filters" className={cn(styles.filters, className)} {...props} />
)

const GitHistoryTableHeader = ({ className, ...props }: ComponentProps<'div'>) => (
  <div data-slot="git-history-table-header" className={cn(styles.tableHeader, className)} {...props} />
)

const GitHistoryCommitDetail = forwardRef<HTMLDivElement, ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} data-slot="git-history-commit-detail" className={cn(styles.commitDetail, className)} {...props} />
  ),
)
GitHistoryCommitDetail.displayName = 'GitHistoryCommitDetail'

const GitHistoryCommitDetailHeader = ({ className, ...props }: ComponentProps<typeof Toolbar>) => (
  <Toolbar data-slot="git-history-commit-detail-header" className={cn(styles.commitDetailHeader, className)} {...props} />
)

const GitHistoryCommitFileList = ({ className, ...props }: ComponentProps<'div'>) => (
  <div data-slot="git-history-commit-file-list" className={cn(styles.fileList, className)} {...props} />
)

const GitHistoryDiffViewport = ({ className, ...props }: ComponentProps<'div'>) => (
  <div data-slot="git-history-diff-viewport" className={cn(styles.diffViewport, className)} {...props} />
)

const GitHistoryInlinePatch = ({ className, ...props }: ComponentProps<'div'>) => (
  <div data-slot="git-history-inline-patch" className={cn(styles.inlinePatch, className)} {...props} />
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
