import type * as React from 'react'

import { cn } from '@/lib/utils'
import { CodeText, Text } from './Settings'

type FileStateValue =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'
  | 'nothing'

const FILE_STATE: Record<FileStateValue, { letter: string; label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'brand' }> = {
  modified: { letter: 'M', label: 'Modified', tone: 'warning' },
  added: { letter: 'A', label: 'Added', tone: 'success' },
  deleted: { letter: 'D', label: 'Deleted', tone: 'danger' },
  renamed: { letter: 'R', label: 'Renamed', tone: 'brand' },
  untracked: { letter: 'U', label: 'Untracked', tone: 'success' },
  conflicted: { letter: '!', label: 'Conflicted', tone: 'danger' },
  nothing: { letter: '—', label: 'Records nothing', tone: 'neutral' },
}

/** The compact state letter shared by every file-change surface. */
const FileState = ({ state, className }: { state: FileStateValue; className?: string }) => {
  const presentation = FILE_STATE[state]
  return (
    <span
      data-slot="file-state"
      data-status={state}
      aria-label={presentation.label}
      className={cn('inline-block w-4 shrink-0', className)}
    >
      <Text role="meta" tone={presentation.tone} className="font-semibold">
        <CodeText>{presentation.letter}</CodeText>
      </Text>
    </span>
  )
}

/** One app-wide reading of additions and removals. */
const ChangeStats = ({
  added,
  removed,
  binary,
  className,
}: {
  added?: number
  removed?: number
  binary?: boolean
  className?: string
}) => (
  <span
    data-slot="change-stats"
    className={cn('inline-flex shrink-0 items-center gap-1.5 tabular-nums', className)}
  >
    {binary ? (
      <Text role="meta">binary</Text>
    ) : (
      <>
        <Text role="meta" tone="success" numeric>+{added ?? 0}</Text>
        <Text role="meta" tone="danger" numeric>−{removed ?? 0}</Text>
      </>
    )}
  </span>
)

/** One section of a patch, separated from the hunk before it. */
const PatchSection = ({ className, ...props }: React.ComponentProps<'section'>) => (
  <section
    data-slot="patch-section"
    className={cn('border-t border-(--hd-border-strong) first:border-t-0', className)}
    {...props}
  />
)

/** The named bar above a file or hunk in a patch. */
const PatchHeader = ({
  className,
  level = 'file',
  ...props
}: React.ComponentProps<'header'> & { level?: 'file' | 'hunk' }) => (
  <header
    data-slot="patch-header"
    data-level={level}
    className={cn(
      'flex items-center',
      level === 'file'
        ? 'gap-2.5 border-b border-(--hd-border-strong) bg-(--hd-card) px-3 py-2'
        : 'gap-2.5 px-3 py-1',
      className,
    )}
    {...props}
  />
)

export { ChangeStats, FileState, PatchHeader, PatchSection, type FileStateValue }
