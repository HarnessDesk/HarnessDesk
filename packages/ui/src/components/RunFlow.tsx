import { useMemo, useState } from 'react'

import type { FlowEntry, FlowExecution, FlowOrigin, SeatRecord } from '@harnessdesk/protocol'

import { ActionError, Button, CodeBlock, Dialog, FlowGraph, Note, RefusedAction, Text } from '../design'
import { ceilingsOfRun, flowModel } from '../lib/flow-model'
import { useStore } from '../state/context'

const PLACE: Readonly<Record<FlowOrigin, string>> = {
  project: 'In the project',
  user: 'On your Mac',
  builtin: 'Ships with HarnessDesk',
}

/** The file as the catalogue lists it now, found by the name the Run froze: a Run keeps no id or place of its own. */
const entryNamed = (entries: readonly FlowEntry[], name: string): FlowEntry | undefined =>
  entries.find((one) => one.name === name && one.problem === null && one.format !== null)

/**
 * The Flow half of a Run's header switch: the Flow the Run started with,
 * drawn, and the way to read its file.
 *
 * A Run holds its Flow frozen, so what is drawn here cannot change under it;
 * the file is whatever the catalogue holds now, and may have moved on. That
 * is said where the file opens. Editing stays where it was, in the catalogue,
 * for the next Run.
 */
export const RunFlow = ({ execution, root, seats }: {
  execution: Pick<FlowExecution, 'document' | 'revision' | 'rounds'>
  /** The project the Run belongs to, where its Flow's file is looked for; null when it is not known. */
  root: string | null
  /** The Seats the Run opened, for the ceiling each step's seats ran under and whether it was held or only asked. */
  seats: readonly Pick<SeatRecord, 'id' | 'ceiling'>[]
}) => {
  const store = useStore()
  const flow = execution.document.flow
  const model = useMemo(() => flowModel(flow, { ceilings: ceilingsOfRun(execution.rounds, seats) }), [flow, execution.rounds, seats])
  const [reading, setReading] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [opened, setOpened] = useState<{ readonly entry: FlowEntry; readonly text: string } | null>(null)

  const open = async (): Promise<void> => {
    if (!root || reading) return
    setReading(true)
    setProblem(null)
    try {
      const entry = entryNamed(await store.flowCatalog(root), flow.name)
      if (!entry) {
        setProblem(`No flow called “${flow.name}” is in the catalogue any more.`)
        return
      }
      setOpened({ entry, text: await store.flowSource(root, entry.id, entry.origin) })
    } catch (error) {
      setProblem(`The file could not be read: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setReading(false)
    }
  }

  return (
    <div data-slot="run-flow" className="flex min-w-0 flex-col gap-4">
      <div data-slot="run-flow-head" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
          <Text role="subject" className="min-w-0 break-words">{flow.name}</Text>
          <Text role="meta">{execution.revision ? `revision ${execution.revision} · ` : ''}frozen when this Run started</Text>
        </span>
        <RefusedAction reason={root ? undefined : 'This Run’s project is not known here, so its file cannot be found.'}>
          <Button size="sm" variant="outline" disabled={reading} onClick={() => void open()}>Open the file</Button>
        </RefusedAction>
      </div>
      {problem && <ActionError>{problem}</ActionError>}
      <FlowGraph model={model} />
      {opened && (
        <Dialog title={opened.entry.name} size="xl" tall onClose={() => setOpened(null)}>
          <Text role="meta" className="break-words">{PLACE[opened.entry.origin]} · {opened.entry.path}</Text>
          <Note>This is the file as it is now. The Run keeps the revision it started with.</Note>
          <CodeBlock output={opened.text} />
        </Dialog>
      )}
    </div>
  )
}
