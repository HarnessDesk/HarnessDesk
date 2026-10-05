import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import type { LibraryEntry } from '@harnessdesk/protocol'

import { RuntimeMark } from './BrandIcons'
import { Button, Chip, CodeText, IconTile, ListRow, ListRows, Monogram, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, Text } from '../design'
import { Tooltip, TooltipContent, TooltipTrigger } from '../design'
import { runtimeTint } from '../lib/accounts'
import { useSnapshot } from '../state/context'
import { ChevronIcon } from './Icons'
import type { LibraryColumn } from './LibraryActions'
import styles from './SkillRow.module.css'

// Trailing facts use 283px in the four-agent rig. At 558px total, the
// remaining copy still splits descriptions into two-word lines; 600px
// leaves about 293px of text. Teams uses the same container-width cutoff.
const NARROW_LIST_WIDTH = 600
const NarrowList = createContext(false)

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
  const narrow = useContext(NarrowList)
  const finding = useMemo(() => findingFor(entry, columns), [entry, columns])
  const loaded = entry.reach.filter(reach => reach.state === 'reaches')
  const title = <span className={`${styles.name} ${narrow ? styles.narrowName : ''}`}>
    <Text role="subject" truncate>{entry.title ?? entry.name}</Text>
    <Text role="meta" ink="muted" truncate className={narrow ? 'max-w-1/2 shrink-0' : 'max-w-full shrink-0'}>
      <CodeText as="code" size="inherit">{entry.kind === 'skill' ? `/${entry.name}` : entry.name}</CodeText>
    </Text>
  </span>
  const description = <Text as="span" role="muted" ink="muted" data-skill-description="" className={`whitespace-normal ${narrow ? 'line-clamp-2 text-balance' : 'block [overflow-wrap:anywhere]'}`}>
    {entry.description ?? (entry.kind === 'skill' ? 'No description in its frontmatter' : 'No description provided')}
  </Text>
  const faces = <span className={styles.faces}>
    {narrow && <span className="sr-only">Loaded by </span>}
    {loaded.length === 0 ? <Text role="muted" ink="muted" title={narrow ? 'Loaded by none' : undefined}>None</Text> : loaded.map(reach => {
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
  if (narrow) return <ListRow
    as="button"
    interactive
    data-slot="skill-row"
    onClick={onOpen}
    title={title}
    subtitle={description}
    wrapSubtitle
    meta={<Chip tone={finding?.tone === 'warn' ? 'warning' : 'neutral'} size="sm">{finding?.text ?? 'Ready'}</Chip>}
    trail={<>{faces}<ChevronIcon size={15} /></>}
  />
  return (
    <TableRow
      interactive
      data-slot="skill-row"
      onClick={onOpen}
      className="cursor-pointer"
    >
      <TableCell className="min-w-48 whitespace-normal">
        <Button
          variant="ghost"
          size="content"
          hoverFill={false}
          onClick={event => { event.stopPropagation(); onOpen() }}
          className="w-0 min-w-full flex-col items-start justify-start gap-0 text-left"
        >
          {title}
          {description}
        </Button>
      </TableCell>
      <TableCell className="w-px whitespace-nowrap">
        {finding?.tone === 'warn'
          ? <Chip tone="warning" size="sm">{finding.text}</Chip>
          : <Text role="muted" ink="muted">{finding?.text ?? 'Ready'}</Text>}
      </TableCell>
      <TableCell className="w-px whitespace-nowrap">
        <span className="flex items-center justify-between gap-3">
          {faces}
          <ChevronIcon size={15} />
        </span>
      </TableCell>
    </TableRow>
  )
}

export const SkillList = ({ children, kind = 'skill' }: { children: React.ReactNode; kind?: 'skill' | 'mcp' }) => {
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    if (!box || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? Infinity) < NARROW_LIST_WIDTH))
    observer.observe(box)
    return () => observer.disconnect()
  }, [box])
  return <div ref={setBox} data-slot="skill-list" data-layout={narrow ? 'list' : 'table'}>
    <NarrowList.Provider value={narrow}>
    {narrow ? <ListRows>{children}</ListRows> : <Table variant="framed">
    <TableCaption variant="sr-only">
      Each row is one entry; its state and the agents that load it appear in separate columns.
    </TableCaption>
    <TableHeader>
      <TableRow>
        <TableHead>{kind === 'skill' ? 'Skill' : 'Server'}</TableHead>
        <TableHead className="w-px whitespace-nowrap">State</TableHead>
        <TableHead className="w-px whitespace-nowrap">Loaded by</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>{children}</TableBody>
    </Table>}
    </NarrowList.Provider>
  </div>
}
