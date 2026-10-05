import { useMemo } from 'react'

import {
  entryHasProblem,
  type LibraryEntry,
} from '@harnessdesk/protocol'

import { RuntimeMark } from './BrandIcons'
import { Button, Chip, CodeText, IconTile, Monogram, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Text } from '../design'
import { Tooltip, TooltipContent, TooltipTrigger } from '../design'
import { runtimeTint } from '../lib/accounts'
import { useSnapshot } from '../state/context'
import { ChevronIcon } from './Icons'
import type { LibraryColumn } from './LibraryActions'
import styles from './SkillRow.module.css'

/**
 * The one or two letters on the mark.
 *
 * Word-initials where the name has words — `code-review` reads as CR, which
 * is recognisable — and the first two letters where it is a single word,
 * because one letter on a tile is a placeholder and two is a monogram.
 *
 */
export const monogramFor = (name: string): string => {
  const words = name.split(/[-_.\s]+/).filter((one) => one !== '')
  if (words.length >= 2) {
    return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase()
  }
  return (words[0] ?? name).slice(0, 2).toUpperCase()
}

/**
 * The one finding worth saying about this entry in the State column, or none.
 *
 * Ordered by **what the reader would do about it**, which is not the same as
 * by severity. `hollow`, `differs` and `off` all mean nothing reaches, so a
 * naive "reaches nobody first" rule captions an empty directory, a pair of
 * divergent copies and a thrown switch with the same words — naming a symptom
 * whose cause is sitting right there unsaid.
 *
 * A healthy entry returns no finding; the list renders a quiet Ready word.
 */
export const findingFor = (
  entry: LibraryEntry,
  columns: readonly LibraryColumn[],
): { text: string; tone: 'warn' | 'quiet' } | null => {
  if (entry.copies.some((copy) => copy.hollow)) return { text: 'Empty on disk', tone: 'warn' }
  // Before every other finding: an agent that read the definition and refused
  // it has told us something no amount of reading the disk could, and it is
  // the one thing on this row somebody can act on.
  const refused = entry.reach.filter((one) => one.state === 'rejected')
  if (refused.length > 0) {
    const only = refused[0]
    const label =
      refused.length === 1
        ? (columns.find((column) => column.id === only?.runtime)?.label ?? 'one agent')
        : `${refused.length} agents`
    return { text: `Refused by ${label}`, tone: 'warn' }
  }
  const digests = new Set(entry.copies.filter((one) => !one.hollow).map((one) => one.digest))
  if (digests.size > 1) return { text: `${digests.size} copies differ`, tone: 'warn' }

  const offColumns = entry.reach.filter((one) => one.state === 'off')
  if (offColumns.length > 0) {
    if (offColumns.length === entry.reach.length) return { text: 'Switched off', tone: 'quiet' }
    const only = offColumns[0]
    const label =
      offColumns.length === 1
        ? (columns.find((column) => column.id === only?.runtime)?.label ?? 'one agent')
        : `${offColumns.length} agents`
    return { text: `Off in ${label}`, tone: 'quiet' }
  }

  // Said before "loaded by nobody", and quietly: this is the row a second
  // after the page installed something, and the person is looking straight at
  // it to see whether it worked. It did — the caption is the sentence that
  // tells them the last step is the agent's, not theirs.
  const staleColumns = entry.reach.filter((one) => one.state === 'stale')
  if (staleColumns.length > 0) {
    const only = staleColumns[0]
    const label =
      staleColumns.length === 1
        ? (columns.find((column) => column.id === only?.runtime)?.label ?? 'one agent')
        : `${staleColumns.length} agents`
    return { text: `Not read yet by ${label}`, tone: 'quiet' }
  }

  if (entry.reach.length > 0 && entry.reach.every((one) => one.state !== 'reaches')) {
    // The two ways to reach nobody are worth telling apart: a copy in a
    // directory nothing scans is one move from working, and the move is
    // different from the one an absent skill needs.
    return {
      text: entry.copies.some((copy) => copy.readBy.length === 0)
        ? 'Where no agent looks'
        : 'Loaded by nobody',
      tone: 'warn',
    }
  }
  return null
}

/** Three labelled facts, with the whole row opening the definition. */
export const SkillRow = ({ entry, columns, onOpen }: {
  entry: LibraryEntry
  columns: readonly LibraryColumn[]
  onOpen: () => void
}) => {
  const snapshot = useSnapshot()
  const finding = useMemo(() => findingFor(entry, columns), [entry, columns])
  const loaded = entry.reach.filter(reach => reach.state === 'reaches')
  return (
    <TableRow
      interactive
      data-slot="skill-row"
      onClick={onOpen}
      {...(entryHasProblem(entry) ? { 'data-problem': '' } : {})}
      className="cursor-pointer"
    >
      <TableCell className="whitespace-normal">
        <Button
          variant="link"
          size="content"
          onClick={event => { event.stopPropagation(); onOpen() }}
          className="w-full flex-col items-start justify-start gap-0 text-left"
        >
          <span className={styles.name}>
            <Text role="subject" truncate>{entry.title ?? entry.name}</Text>
            <Text role="meta" ink="muted" truncate className="max-w-1/2 shrink-0">
              <CodeText as="code" size="inherit">{entry.kind === 'skill' ? `/${entry.name}` : entry.name}</CodeText>
            </Text>
          </span>
          <Text as="span" role="muted" ink="muted" className="block whitespace-normal">
            {entry.description ?? (entry.kind === 'skill' ? 'No description in its frontmatter' : 'No description provided')}
          </Text>
        </Button>
      </TableCell>
      <TableCell className="whitespace-normal [overflow-wrap:anywhere]">
        {finding?.tone === 'warn'
          ? <Chip tone="warning" size="sm">{finding.text}</Chip>
          : <Text role="muted" ink="muted">{finding?.text ?? 'Ready'}</Text>}
      </TableCell>
      <TableCell>
        <span className="flex items-center justify-between gap-3">
          <span className={styles.faces}>
            {loaded.length === 0 ? <Text role="muted" ink="muted">None</Text> : loaded.map(reach => {
              const column = columns.find(column => column.id === reach.runtime)
              if (!column) return null
              return (
                <Tooltip key={reach.runtime}>
                  <TooltipTrigger render={
                    <IconTile
                      size="stack"
                      shape="face"
                      tint={runtimeTint(reach.runtime, snapshot.accountsByRuntime, snapshot.accountPrefs)}
                      role="img"
                      aria-label={column.label}
                    />
                  }>
                    {column.info ? <RuntimeMark runtime={column.info} size={12} /> : <Monogram>{column.label[0]}</Monogram>}
                  </TooltipTrigger>
                  <TooltipContent>{column.label}</TooltipContent>
                </Tooltip>
              )
            })}
          </span>
          <ChevronIcon size={15} />
        </span>
      </TableCell>
    </TableRow>
  )
}

export const SkillList = ({ children, kind = 'skill' }: { children: React.ReactNode; kind?: 'skill' | 'mcp' }) => (
  <Table variant="framed" className="table-fixed">
    <TableHeader>
      <TableRow>
        <TableHead className="w-3/5">{kind === 'skill' ? 'Skill' : 'Server'}</TableHead>
        <TableHead>State</TableHead>
        <TableHead>Loaded by</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>{children}</TableBody>
  </Table>
)
