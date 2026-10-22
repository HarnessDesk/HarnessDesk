import { useId } from 'react'
import type { LibraryEntry } from '@harnessdesk/protocol'
import { Chip, CompactBoardCard, RowButton, Text } from '../design'
import { inlineMarkdown } from '../lib/markdown-inline'
import { libraryUpdateFor } from '../lib/library-updates'
import { findingFor } from './SkillRow'
import type { LibraryColumn } from './LibraryActions'

export const SkillCard = ({ entry, columns, onOpen, view = 'cards' }: {
  readonly view?: 'cards' | 'list'; readonly entry: LibraryEntry; readonly columns: readonly LibraryColumn[]; readonly onOpen: () => void
}) => {
  const descriptionId = useId()
  const findingId = useId()
  const scopeId = useId()
  const reachId = useId()
  const readersId = useId()
  const finding = findingFor(entry, columns)
  const warning = finding?.tone === 'warn'
  const problem = warning ? finding.text : libraryUpdateFor(entry)?.status === 'behind' ? 'Update available' : null
  const loaded = entry.reach.filter(one => one.state === 'reaches')
  const readers = loaded.map(one => columns.find(column => column.id === one.runtime)?.label ?? one.runtime).join(', ')
  const scope = [...new Set(entry.copies.map(copy => copy.scope === 'user' ? 'Personal' : 'Project'))].join(' · ')
  const unread = entry.reach.some(one => one.state === 'unscanned' || one.state === 'stale')
  const reachLabel = loaded.length === 0 ? (unread ? 'Not read yet' : 'Not loaded') : `${loaded.length} ${loaded.length === 1 ? 'runtime' : 'runtimes'}`
  const reachTitle = readers || (unread ? 'Runtime availability has not been read' : 'No runtime loads this skill')
  if (view === 'list') return <RowButton kind="record" title={entry.title ?? entry.name} onClick={onOpen}
    desc={<Text role="muted" lines={2}><span dangerouslySetInnerHTML={{ __html: inlineMarkdown(entry.description ?? 'No description in its frontmatter') }} /></Text>}
    control={problem ? <Chip tone={warning ? 'warning' : 'neutral'} size="sm">{problem}</Chip> : <Text role="meta" title={reachTitle}>{reachLabel}</Text>} />
  return <CompactBoardCard data-slot="skill-card" label={entry.title ?? entry.name} title={entry.title ?? entry.name} onOpen={onOpen}
    aria-describedby={`${descriptionId} ${scopeId} ${reachId} ${readersId}${problem ? ` ${findingId}` : ''}`} detailProps={{ id: descriptionId }}
    detailLines={2} detail={<span data-skill-description="" dangerouslySetInnerHTML={{ __html: inlineMarkdown(entry.description ?? 'No description in its frontmatter') }} />}
    footer={<><Text id={scopeId} role="meta" ink="muted">{scope}</Text><Text id={reachId} role="meta" ink="muted" title={reachTitle}>{reachLabel}</Text><span id={readersId} className="sr-only">{readers ? `Loaded by ${readers}` : reachTitle}</span></>}
    finding={problem ? { text: problem, tone: warning ? 'warn' : 'quiet', id: findingId } : undefined} />
}
