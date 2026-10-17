import { useId } from 'react'
import type { LibraryEntry } from '@harnessdesk/protocol'
import { isReachProblem } from '@harnessdesk/protocol'
import { CompactBoardCard, Text } from '../design'
import { inlineMarkdown } from '../lib/markdown-inline'
import { REACH_NAME } from '../lib/reach-states'
import { libraryUpdateFor } from '../lib/library-updates'
import { RuntimeMark } from './BrandIcons'
import { findingFor } from './SkillRow'
import type { LibraryColumn } from './LibraryActions'

export const SkillCard = ({ entry, columns, onOpen }: {
  readonly entry: LibraryEntry; readonly columns: readonly LibraryColumn[]; readonly onOpen: () => void
}) => {
  const descriptionId = useId()
  const findingId = useId()
  const finding = findingFor(entry, columns)
  const warning = finding?.tone === 'warn'
  const problem = warning ? finding.text : libraryUpdateFor(entry)?.status === 'behind' ? 'Update available' : null
  const reaching = entry.reach.filter(one => one.state === 'reaches').length
  return <CompactBoardCard data-slot="skill-card" label={entry.title ?? entry.name} title={entry.title ?? entry.name} onOpen={onOpen}
    aria-describedby={`${descriptionId}${problem ? ` ${findingId}` : ''}`} detailProps={{ id: descriptionId }}
    marks={{ label: `Loaded by ${reaching} of ${columns.length} runtimes`, items: columns.map(column => {
      const state = entry.reach.find(one => one.runtime === column.id)?.state ?? 'absent'
      return { id: column.id, title: `${column.label}: ${REACH_NAME[state]}`, active: state === 'reaches',
        attention: isReachProblem(state) || state === 'unscanned', props: { 'data-runtime-state': state, 'data-problem': isReachProblem(state) || state === 'unscanned' || undefined },
        mark: column.info ? <RuntimeMark runtime={column.info} size={13} /> : <Text role="meta">{column.label.slice(0, 1)}</Text> }
    }) }}
    detailLines={2} detail={<span data-skill-description="" dangerouslySetInnerHTML={{ __html: inlineMarkdown(entry.description ?? 'No description in its frontmatter') }} />}
    finding={problem ? { text: problem, tone: warning ? 'warn' : 'quiet', id: findingId } : undefined} />
}
