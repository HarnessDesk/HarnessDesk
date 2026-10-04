import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { FlowEntry, FlowExecution, FlowOrigin, SeatRecord, Session, SessionKey } from '@harnessdesk/protocol'

import { ActionError, Button, CodeBlock, Dialog, FlowGraph, Note, RefusedAction, Text, type Tint } from '../design'
import { flowOverlay, type OverlayCheckHistory } from '../lib/flow-overlay'
import { doingLine, type DoingLine } from '../lib/team-overview'
import type { Intent } from '@harnessdesk/protocol'
import { ceilingsOfRun, flowModel } from '../lib/flow-model'
import { useStore } from '../state/context'

const PLACE: Readonly<Record<FlowOrigin, string>> = {
  project: 'In the project',
  user: 'On your Mac',
  builtin: 'Ships with HarnessDesk',
}

/**
 * The files the catalogue lists now under the name the Run froze: a Run keeps
 * no id or place of its own. More than one is a copy saved under another file
 * name, and the Run cannot say which of them it started from.
 */
const entriesNamed = (entries: readonly FlowEntry[], name: string): readonly FlowEntry[] =>
  entries.filter((one) => one.name === name && one.problem === null && one.format !== null)

/**
 * The Flow half of a Run's header switch: the Flow the Run started with,
 * drawn, and the way to read its file.
 *
 * A Run holds its Flow frozen, so what is drawn here cannot change under it;
 * the file is whatever the catalogue holds now, and may have moved on. That
 * is said where the file opens. Editing stays where it was, in the catalogue,
 * for the next Run.
 */
export const RunFlow = ({ execution, root, seats, cards = [], attempts, selectedStep, onSelectStep, faces, faceTints, doing, sessions }: {
  execution: Pick<FlowExecution, 'document' | 'revision' | 'rounds'> & Partial<Pick<FlowExecution, 'operations' | 'state' | 'currentEndedAt'>>
  /** The project the Run belongs to, where its Flow's file is looked for; null when it is not known. */
  root: string | null
  /** The Seats the Run opened, for the ceiling each step's seats ran under and whether it was held or only asked. */
  seats: readonly Pick<SeatRecord, 'id' | 'ceiling'>[]
  sessions?: ReadonlyMap<SessionKey, Session>
  cards?: readonly Intent[]
  attempts?: ReadonlyMap<number, OverlayCheckHistory>
  selectedStep?: string | null
  onSelectStep?: (step: string) => void
  faces?: ReadonlyMap<string, ReactNode>
  faceTints?: ReadonlyMap<string, Tint>
  doing?: ReadonlyMap<string, string | null>
}) => {
  const store = useStore()
  const flow = execution.document.flow
  const model = useMemo(() => flowModel(flow, { ceilings: ceilingsOfRun(execution.rounds, seats) }), [flow, execution.rounds, seats])
  const overlay = useMemo(() => execution.state === undefined ? undefined : flowOverlay({ execution: { ...execution, state: execution.state, operations: execution.operations ?? [] }, model, cards, attempts, sessions }), [execution, model, cards, attempts, sessions])
  const [now, setNow] = useState(Date.now)
  const held = useRef(new Map<string, DoingLine>())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const stableDoing = new Map([...doing ?? []].map(([id, next]) => {
    const line = doingLine(held.current.get(id) ?? null, next, now)
    held.current.set(id, line)
    return [id, line.line]
  }))
  const [reading, setReading] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [opened, setOpened] = useState<{ readonly entry: FlowEntry; readonly text: string } | null>(null)

  const open = async (): Promise<void> => {
    if (!root || reading) return
    setReading(true)
    setProblem(null)
    try {
      const [entry, ...others] = entriesNamed(await store.flowCatalog(root), flow.name)
      if (!entry) {
        setProblem(`No flow called “${flow.name}” is in the catalogue any more.`)
        return
      }
      if (others.length > 0) {
        setProblem(`More than one flow in the catalogue is called “${flow.name}”, so which file this Run started from cannot be told here.`)
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
      <FlowGraph model={model} overlay={overlay} now={now} selectedStep={selectedStep} onSelectStep={onSelectStep} faces={faces} faceTints={faceTints} doing={stableDoing} />
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
