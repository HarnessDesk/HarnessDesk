import { useEffect, useState } from 'react'

import type { ProjectChecks as Checks } from '@harnessdesk/protocol'

import { Chip, CodeText, EmptyState, ListRow, ListRows, Note, Row, Rows, Section, Text } from '../design'
import { shortSha } from '../lib/evidence'
import { shortPath } from '../lib/paths'
import { useSnapshot, useStore } from '../state/context'

export const ProjectChecks = ({ root }: { readonly root: string }) => {
  const store = useStore()
  const [read, setRead] = useState<
    { readonly root: string; readonly checks: Checks }
    | { readonly root: string; readonly problem: string }
    | null
  >(null)

  useEffect(() => {
    let live = true
    store.projectChecks(root).then(
      (checks) => {
        if (live) setRead({ root, checks })
      },
      (error: unknown) => {
        if (live) setRead({ root, problem: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      live = false
    }
  }, [store, root])

  if (!read || read.root !== root) return null
  if ('problem' in read) {
    return (
      <Section title="Checks">
        <Rows>
          <Row title="Its checks could not be read" desc={read.problem} />
        </Rows>
      </Section>
    )
  }
  return read.checks.exists ? <ProjectChecksView checks={read.checks} /> : null
}

export const ProjectChecksView = ({ checks }: { readonly checks: Checks }) => {
  const snapshot = useSnapshot()
  return (
    <Section
      title="Checks"
      description={`Read from ${shortPath(checks.file, snapshot.home)}${checks.at ? `, as committed at ${shortSha(checks.at)}` : ''}. A card runs one only once this Mac has approved its command, and asks again whenever the file changes.`}
    >
      {checks.uncommitted && (
        <Note tone="warn">
          Your working copy of this file is not what is committed. A check runs only as it is committed, so commit the
          change for a card to offer it.
        </Note>
      )}
      <ListRows>
        {checks.checks.length === 0 && checks.problems.length === 0 && <EmptyState variant="row" title="No checks" />}
        {checks.checks.map((check) => (
          <ListRow
            density="compact"
            key={check.name}
            title={check.name}
            subtitle={<CodeText>{check.run}</CodeText>}
            trail={check.seen === 'changed' ? <Chip tone="warning">Changed</Chip> : <Text role="meta">{check.seen === 'yes' ? 'Approved' : 'Not approved'}</Text>}
          />
        ))}
        {checks.problems.map((problem) => (
          <ListRow
            density="compact"
            key={`${problem.at}:${problem.text}`}
            title={problem.at === '' ? 'The file' : problem.at}
            subtitle={problem.text}
            wrapSubtitle
            trail={<Chip tone="danger">Not offered</Chip>}
          />
        ))}
      </ListRows>
    </Section>
  )
}
