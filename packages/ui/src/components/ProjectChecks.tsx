import { useEffect, useState } from 'react'

import type { ProjectChecks as Checks } from '@harnessdesk/protocol'

import { Chip, CodeText, Note, Row, Rows, RowValue, SectionHead } from '../design'
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
      <section aria-label="Checks">
        <SectionHead name="Checks" />
        <Rows>
          <Row title="Its checks could not be read" desc={read.problem} />
        </Rows>
      </section>
    )
  }
  return read.checks.exists ? <ProjectChecksView checks={read.checks} /> : null
}

const seenWords = (seen: 'yes' | 'no' | 'changed'): string =>
  seen === 'yes'
    ? 'Approved on this Mac'
    : seen === 'changed'
      ? 'Changed since approved here'
      : 'Not approved on this Mac'

export const ProjectChecksView = ({ checks }: { readonly checks: Checks }) => {
  const snapshot = useSnapshot()
  return (
    <section aria-label="Checks">
      <SectionHead name="Checks" />
      <Note>
        {`Read from ${shortPath(checks.file, snapshot.home)}${checks.at ? `, as committed at ${shortSha(checks.at)}` : ''}. A card runs one only once this Mac has approved its command, and asks again whenever the file changes.`}
      </Note>
      {checks.uncommitted && (
        <Note tone="warn">
          Your working copy of this file is not what is committed. A check runs only as it is committed, so commit the
          change for a card to offer it.
        </Note>
      )}
      <Rows>
        {checks.checks.length === 0 && checks.problems.length === 0 && <Row title="It names no checks" />}
        {checks.checks.map((check) => (
          <Row
            key={check.name}
            title={check.name}
            desc={<CodeText>{check.run}</CodeText>}
            control={<RowValue>{seenWords(check.seen)}</RowValue>}
          />
        ))}
        {checks.problems.map((problem) => (
          <Row
            key={`${problem.at}:${problem.text}`}
            title={problem.at === '' ? 'The file' : problem.at}
            desc={problem.text}
            control={<Chip state="broken" label="Not offered" />}
          />
        ))}
      </Rows>
    </section>
  )
}
