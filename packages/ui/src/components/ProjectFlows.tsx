import { useEffect, useState } from 'react'

import type { FlowEntry, FlowOrigin } from '@harnessdesk/protocol'

import { Button, Chip, Note, Row, Rows, SectionHead } from '../design'
import { useStore } from '../state/context'
import { FlowUpdate } from './FlowUpdate'

export interface ProjectFlowsProps {
  readonly root: string
  readonly current: boolean
}

const ORIGIN_WORDS: Readonly<Record<FlowOrigin, string>> = { project: 'Project', user: 'Your Mac', builtin: 'Ships with HarnessDesk' }

/**
 * Workspaces › a project › its flows: the layered catalogue a Goal would
 * start from — its own, then this Mac's, then the ones that ship — read the
 * same way the Agents section above it reads its roster.
 *
 * Reading never creates `.harnessdesk`: an empty or unopened project is read
 * exactly as it is, and the note below explains where one would live rather
 * than making the folder to say so. Inspecting, updating and customizing a
 * flow all work for a project that is not the open one; only actually
 * starting it needs that project open, which happens from the composer, not
 * from here.
 */
export const ProjectFlows = ({ root, current }: ProjectFlowsProps) => {
  const store = useStore()
  const [entries, setEntries] = useState<readonly FlowEntry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ readonly id: string; readonly mode: 'update' | 'customize' } | null>(null)

  useEffect(() => {
    let live = true
    setProblem(null)
    store.flowCatalog(root).then(
      (list) => {
        if (live) setEntries(list)
      },
      (error: unknown) => {
        if (live) setProblem(error instanceof Error ? error.message : 'Its flows could not be read.')
      },
    )
    return () => {
      live = false
    }
  }, [store, root])

  const reload = (): void => {
    void store.flowCatalog(root).then(setEntries, () => {})
  }

  return (
    <section aria-label="Flows">
      <SectionHead name="Flows" />
      <Note>
        Editable files in <code>.harnessdesk/flows</code>, versioned with the project’s code — its own first, then
        yours, then the ones that ship as starting points.
      </Note>
      <Rows>
        {problem && <Row title={problem} />}
        {!problem && entries === null && <Row title="Reading…" />}
        {entries?.length === 0 && <Row title="No flows of its own" desc="Customize a shipped one, below, to give this project its own." />}
        {entries?.map((entry) => (
          <FlowRow key={entry.id} root={root} entry={entry} onOpen={(mode) => setDialog({ id: entry.id, mode })} />
        ))}
      </Rows>
      {!current && entries && entries.length > 0 && <Note>Open this project to start its flow.</Note>}
      {dialog && (
        <FlowUpdate
          root={root}
          id={dialog.id}
          mode={dialog.mode}
          onClose={() => setDialog(null)}
          onApplied={reload}
        />
      )}
    </section>
  )
}

const FlowRow = ({
  root, entry, onOpen,
}: {
  readonly root: string
  readonly entry: FlowEntry
  readonly onOpen: (mode: 'update' | 'customize') => void
}) => {
  const store = useStore()
  const legacy = entry.format === 'legacy'
  const broken = entry.problem !== null
  const shadowPlace = (origin: FlowOrigin): string =>
    origin === 'project' ? 'in the project' : origin === 'user' ? 'on your Mac' : 'that ships with HarnessDesk'
  const shadowNote = entry.shadows.length > 0
    ? `It shadows a flow ${entry.shadows.map((one) => shadowPlace(one.origin)).join(' and ')}.`
    : null
  const sentence = (text: string | null): string | null => (text ? (text.endsWith('.') || text.endsWith('!') || text.endsWith('?') ? text : `${text}.`) : null)
  const desc = [
    sentence(entry.problem),
    !entry.problem && legacy ? 'This flow uses the old format.' : sentence(entry.description),
    shadowNote,
  ].filter((part): part is string => Boolean(part)).join(' ')

  const action = broken
    ? <Chip state="broken" label="Will not run" />
    : legacy && entry.origin === 'project'
      ? <Button size="sm" variant="outline" onClick={() => onOpen('update')}>Update…</Button>
      : entry.origin === 'project'
        ? <Button size="sm" variant="outline" onClick={() => store.openFile(`${root}/${entry.path}`)}>Open file</Button>
        : <Button size="sm" variant="outline" onClick={() => onOpen('customize')}>Customize…</Button>

  return (
    <Row
      title={entry.name}
      wrapDesc
      {...(desc ? { desc } : {})}
      control={(
        <span className="inline-flex items-center gap-(--hd-space-2)">
          <Chip tone="neutral">{ORIGIN_WORDS[entry.origin]}</Chip>
          {action}
        </span>
      )}
    />
  )
}
