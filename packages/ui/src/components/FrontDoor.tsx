import { useCallback, useEffect, useRef, useState } from 'react'

import type { AgentEntry, FlowEntry, FlowExecution, StartContext } from '@harnessdesk/protocol'

import { ActionError, Banner, Button, Dialog, Field, Input, Note, Row, RowButton, Rows } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { FlowPreviewReport } from './FlowStart'
import { ShapeEditor } from './ShapeEditor'
import { TriggerCreate } from './TriggerCreate'

/**
 * The front door: choose a file-based shape, read its populated dry run,
 * Start. Click one is a row in the list below; click two is *Start* in the
 * footer, once the dry run it reads has nothing in the way — nothing else
 * this dialog does counts toward that, the same rule `NewSessionChoice`
 * already holds for its own two rows.
 *
 * The dry run itself is store state (`snapshot.frontDoor.preview`), not a
 * value this component keeps: `AppStore.previewFrontDoor` owns the one live
 * generation, so a reply for a shape or a variable this dialog has already
 * moved past can never land here and light Start on a stale token.
 */
export interface FrontDoorProps {
  readonly context: StartContext
  readonly goal?: { readonly id: string; readonly revision: number }
  /** Preselects one catalogue entry — a context action that already knows which shape it means. */
  readonly initial?: { readonly id: string; readonly origin: FlowEntry['origin'] }
  readonly onClose: () => void
  readonly onStarted: (execution: FlowExecution) => void
}

type Chosen = { readonly id: string; readonly origin: FlowEntry['origin']; readonly name: string }

/**
 * A shape whose own `layout.frontDoor.contexts` names starts and excludes
 * this one refuses it the moment it is chosen (`previewStart`'s own check) —
 * so it is left off a context-specific list rather than shown only to error
 * out. A shape that names no `contexts` at all, or has none declared,
 * accepts every start; absence is never read as a refusal. `project` (the
 * plain "Start with a team" chooser) is a context like any other here.
 */
const acceptsContext = (entry: FlowEntry, kind: StartContext['kind']): boolean =>
  !entry.frontDoor?.contexts || entry.frontDoor.contexts.includes(kind)

/**
 * Order first, when a shape's own layout names one — the validated ordering
 * this front door offers as its only editorial control — then name/id, the
 * same stable tie-break for everything else. A shape with no declared order
 * has no opinion about its place, so it sorts after every shape that does;
 * unordered shapes and equal orders both fall back to name/id together.
 */
const sortShapes = (entries: readonly FlowEntry[]): readonly FlowEntry[] =>
  [...entries].sort((a, b) => {
    const orderA = a.frontDoor?.order ?? null
    const orderB = b.frontDoor?.order ?? null
    if (orderA !== null && orderB !== null && orderA !== orderB) return orderA - orderB
    if ((orderA === null) !== (orderB === null)) return orderA === null ? 1 : -1
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  })

export const FrontDoor = ({ context, goal, initial, onClose, onStarted }: FrontDoorProps) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const root = context.root
  const [entries, setEntries] = useState<readonly FlowEntry[] | null>(null)
  const [unlisted, setUnlisted] = useState<string | null>(null)
  const [roster, setRoster] = useState<ReadonlyMap<string, AgentEntry>>(new Map())
  const [chosen, setChosen] = useState<Chosen | null>(null)
  const [ownShape, setOwnShape] = useState(false)
  const [everyTime, setEveryTime] = useState(false)
  const [source, setSource] = useState('')
  const [vars, setVars] = useState<Readonly<Record<string, string>>>({})
  const [sentence, setSentence] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startProblem, setStartProblem] = useState<string | null>(null)
  const sequence = useRef(0)
  const sentenceTouched = useRef(false)
  const initialTried = useRef(false)

  // The one open request this dialog is for. Closing — an unmount, same as
  // choosing a different shape mid-flight elsewhere — retires whatever
  // `previewFrontDoor` call is still in the air.
  useEffect(() => {
    store.openFrontDoor(context, goal)
    return () => store.closeFrontDoor()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let live = true
    void store.flowCatalog(root).then(
      (found) => {
        if (live) {
          setUnlisted(null)
          setEntries(found)
        }
      },
      (error: unknown) => {
        if (live) setUnlisted(error instanceof Error ? error.message : String(error))
      },
    )
    void store.agentsIn(root).then(
      (list) => {
        if (live) setRoster(new Map(list.map((entry) => [entry.id, entry])))
      },
      () => {
        // An unread roster leaves seat rows to their bare Agent ids, below.
      },
    )
    return () => {
      live = false
    }
  }, [root, store])

  const runPreview = useCallback(
    async (text: string, nextVars: Readonly<Record<string, string>>): Promise<void> => {
      const mine = ++sequence.current
      try {
        const dry = await store.previewFrontDoor({ context, source: text, vars: nextVars, ...(goal ? { goal } : {}) })
        if (mine !== sequence.current) return
        if (!sentenceTouched.current) setSentence(dry.sentence)
      } catch (error) {
        if (mine !== sequence.current) return
        setProblem(error instanceof Error ? error.message : 'That shape could not be checked.')
      }
    },
    [context, goal, store],
  )

  const choose = useCallback(
    async (entry: FlowEntry): Promise<void> => {
      sequence.current += 1
      const mine = sequence.current
      setChosen({ id: entry.id, origin: entry.origin, name: entry.name })
      setSource('')
      setVars({})
      setSentence('')
      sentenceTouched.current = false
      setProblem(null)
      setStartProblem(null)
      try {
        const text = await store.flowSource(root, entry.id, entry.origin)
        if (mine !== sequence.current) return
        setSource(text)
        // A first, throwaway dry run with no variables typed — only to learn
        // what this shape asks for and which of that the chosen context
        // already answers, so its real defaults can be previewed for real.
        const learn = await store.previewFrontDoor({ context, source: text, vars: {}, ...(goal ? { goal } : {}) })
        if (mine !== sequence.current) return
        setSentence(learn.sentence)
        const inputs = learn.flow.compiled.document.format === 'agents' ? learn.flow.compiled.document.flow.inputs : []
        const defaults = Object.fromEntries(inputs.map((input) => [input.id, learn.vars[input.id] ?? input.default ?? '']))
        setVars(defaults)
        if (inputs.length > 0) await runPreview(text, defaults)
      } catch (error) {
        if (mine !== sequence.current) return
        setProblem(error instanceof Error ? error.message : 'That shape could not be read.')
      }
    },
    [context, goal, root, runPreview, store],
  )

  useEffect(() => {
    if (initial && entries && !chosen && !initialTried.current) {
      initialTried.current = true
      const match = entries.find((one) => one.id === initial.id && one.origin === initial.origin)
      if (match) void choose(match)
    }
  }, [initial, entries, chosen, choose])

  const setVar = useCallback(
    (varId: string, value: string): void => {
      const next = { ...vars, [varId]: value }
      setVars(next)
      void runPreview(source, next)
    },
    [runPreview, source, vars],
  )

  const eligible = entries === null ? [] : sortShapes(entries.filter((entry) => acceptsContext(entry, context.kind)))

  const preview = snapshot.frontDoor?.preview ?? null
  const flow = preview?.flow ?? null
  const compiled = flow?.compiled.document ?? null
  const inputs = compiled?.format === 'agents' ? compiled.flow.inputs : []
  const errors = (flow?.problems ?? []).filter((one) => one.level === 'error')
  const warnings = (flow?.problems ?? []).filter((one) => one.level === 'warning')
  const startable = flow !== null && flow.token !== null && compiled?.format === 'agents' && errors.length === 0
  const sentenceValid = sentence.trim().length > 0 && sentence.trim().length <= 2000

  const start = async (): Promise<void> => {
    if (!preview?.flow.token || !startable || !sentenceValid || starting) return
    setStarting(true)
    setStartProblem(null)
    try {
      const execution = await store.startFlowGoal({
        root,
        source,
        token: preview.flow.token,
        sentence: sentence.trim(),
        vars: preview.vars,
        ...(preview.goal ? { goal: preview.goal } : {}),
      })
      onStarted(execution)
    } catch (error) {
      setStarting(false)
      setStartProblem(error instanceof Error ? error.message : 'The desk did not start this.')
    }
  }

  if (ownShape) {
    return <ShapeEditor root={root} context={context} onClose={() => setOwnShape(false)} onStarted={onStarted} />
  }

  return (
    <Dialog
      title={chosen ? `Start ${chosen.name}` : 'Start a team'}
      size="lg"
      onClose={onClose}
      footer={
        chosen ? (
          <>
            <Button variant="default" disabled={!startable || !sentenceValid || starting} onClick={() => void start()}>
              {starting ? 'Starting…' : 'Start'}
            </Button>
            <Button variant="secondary" disabled={starting} onClick={() => setEveryTime(true)}>
              Every time…
            </Button>
            <Button variant="secondary" disabled={starting} onClick={() => setChosen(null)}>
              Choose a different shape
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        )
      }
    >
      {unlisted !== null && (
        <Banner tone="danger" title="These shapes could not be read">{unlisted}</Banner>
      )}
      {entries !== null && entries.length === 0 && (
        <Note>
          No shapes here yet. A shape is a flow file in <code>.harnessdesk/flows</code>, versioned with the
          code it governs.
        </Note>
      )}
      {entries !== null && entries.length > 0 && eligible.length === 0 && (
        <Note>
          None of this project’s shapes start from {context.kind === 'project' ? 'a plain project' : 'this'}. Choose
          a start one of them names, or edit a shape’s <code>layout.frontDoor.contexts</code>.
        </Note>
      )}

      {!chosen && eligible.length > 0 && (
        <Rows>
          {eligible.map((entry) => (
            <RowButton
              key={`${entry.origin}-${entry.id}`}
              title={entry.problem ? `${entry.name} — will not run` : entry.name}
              wrapDesc
              desc={entry.problem ?? entry.description ?? undefined}
              onClick={() => void choose(entry)}
            />
          ))}
        </Rows>
      )}

      {!chosen && (
        <Rows>
          <RowButton
            title="Your own shape…"
            desc="Build steps and rules in an ordered editor, see the exact file, then start or save it."
            onClick={() => setOwnShape(true)}
          />
        </Rows>
      )}

      {chosen && (
        <>
          <Field label="What finishes this?" error={sentence.trim().length > 2000 ? 'Keep it to 2,000 characters.' : undefined}>
            {(control) => (
              <Input
                {...control}
                aria-label="What finishes this?"
                value={sentence}
                onChange={(event) => {
                  sentenceTouched.current = true
                  setSentence(event.target.value)
                }}
              />
            )}
          </Field>

          {problem && <ActionError>That shape could not be checked. {problem}</ActionError>}

          {inputs.map((input) => (
            <Field key={input.id} label={input.label}>
              {(control) => (
                <Input {...control} value={vars[input.id] ?? ''} onChange={(event) => setVar(input.id, event.target.value)} />
              )}
            </Field>
          ))}

          {preview && (
            <Row
              title={preview.target.label}
              wrapDesc
              desc={[
                preview.target.dirty ? 'Not committed — a working-tree snapshot, never a committed head.' : null,
                preview.target.independence === 'unknown' ? 'Independence from the author is unknown.' : null,
              ].filter(Boolean).join(' ') || undefined}
            />
          )}

          {errors.length > 0 && (
            <Banner tone="danger" title="This will not run yet">
              <ul>
                {errors.map((one) => (
                  <li key={`${one.at}-${one.text}`}><code>{one.at}</code> — {one.text}</li>
                ))}
              </ul>
            </Banner>
          )}

          {flow && compiled?.format === 'agents' && (
            <FlowPreviewReport preview={flow} flow={compiled.flow} warnings={warnings} roster={roster} />
          )}

          {startProblem && <ActionError>{startProblem}</ActionError>}
        </>
      )}

      {everyTime && chosen && (
        <TriggerCreate
          root={root}
          opens={{ flow: chosen.id }}
          onClose={() => setEveryTime(false)}
          onSaved={() => setEveryTime(false)}
        />
      )}
    </Dialog>
  )
}
