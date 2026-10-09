import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { AgentEntry, FlowEntry, FlowExecution, FlowPolicy, StartContext } from '@harnessdesk/protocol'

import { ActionError, Banner, Button, Chip, Dialog, Field, IconTile, Input, Note, Row, SectionHead, Text, Textarea } from '../design'
import { pickerSections, readShapeStarts, recordShapeStart, shapeSummary } from '../lib/team-start'
import { useShell } from '../panels/views'
import { ChevronIcon, FlowIcon, PencilIcon, PlusIcon, ReviewIcon, SearchIcon, SideBySideIcon, TeamIcon } from './Icons'
import { GoalCreate } from './GoalCreate'
import styles from './FrontDoor.module.css'
import { shortSha } from '../lib/evidence'
import { boundInputValues } from '../lib/shapes'
import { useSnapshot, useStore } from '../state/context'
import { FlowStart } from './FlowStart'
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
  const shell = useShell()
  const snapshot = useSnapshot()
  const root = context.root
  const [entries, setEntries] = useState<readonly FlowEntry[] | null>(null)
  const [unlisted, setUnlisted] = useState<string | null>(null)
  const [roster, setRoster] = useState<ReadonlyMap<string, AgentEntry>>(new Map())
  const [query, setQuery] = useState('')
  const [activeCard, setActiveCard] = useState(0)
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [starts] = useState(readShapeStarts)
  const [task, setTask] = useState('')
  const taskRef = useRef('')
  const [plainTeam, setPlainTeam] = useState(false)
  const [briefReading, setBriefReading] = useState(false)
  const [policyPending, setPolicyPending] = useState(false)
  const policySequence = useRef(0)
  const [displayPreview, setDisplayPreview] = useState<import('@harnessdesk/protocol').FrontDoorPreview | null>(null)
  const templates = useRef<FlowPolicy | null>(null)
  const drafts = useRef(new Map<string, { source: string; vars: Readonly<Record<string, string>>; template: FlowPolicy | null }>())
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
      setProblem(null)
      try {
        const dry = await store.previewFrontDoor({ context, source: text, vars: nextVars, ...(goal ? { goal } : {}) })
        if (mine !== sequence.current) return
        setDisplayPreview(dry)
        // Done when is optional; the host's suggestion remains the fallback, never text the person typed.
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
      // Retires the shape just left behind before its own file is even
      // asked for: `openFrontDoor` bumps `previewFrontDoor`'s generation and
      // clears `frontDoor.preview` synchronously, so the token and dry run
      // Start still reads cannot be the one just left behind while this
      // shape's `flow/source` is still in flight — the gap a plain
      // `previewFrontDoor` call (which only clears on its own call) leaves
      // open until this shape's request is actually sent.
      store.openFrontDoor(context, goal)
      setChosen({ id: entry.id, origin: entry.origin, name: entry.name })
      setSource('')
      setVars({})
      templates.current = null
      setDisplayPreview(null)
      setPolicyPending(false)
      setProblem(null)
      setStartProblem(null)
      try {
        const draft = drafts.current.get(`${entry.origin}:${entry.id}`)
        const text = draft?.source ?? await store.flowSource(root, entry.id, entry.origin)
        if (mine !== sequence.current) return
        setSource(text)
        // A first, throwaway dry run with no variables typed — only to learn
        // what this shape asks for and which of that the chosen context
        // already answers, so its real defaults can be previewed for real.
        const learn = await store.previewFrontDoor({ context, source: text, vars: {}, ...(goal ? { goal } : {}) })
        if (mine !== sequence.current) return
        const policy = learn.flow.compiled.document.format === 'agents' ? learn.flow.compiled.document.flow : null
        templates.current = draft?.template ?? policy
        const inputs = learn.flow.compiled.document.format === 'agents' ? learn.flow.compiled.document.flow.inputs : []
        const primary = inputs.find(input => input.id !== 'brief' && (!policy || !boundInputValues(policy).has(input.id)))
        const defaults = { ...Object.fromEntries(inputs.map((input) => [input.id, learn.vars[input.id] ?? input.default ?? ''])), ...draft?.vars }
        if (primary && taskRef.current) defaults[primary.id] = taskRef.current
        else if (primary) { taskRef.current = defaults[primary.id] ?? ''; setTask(taskRef.current) }
        else if (context.kind === 'project' && !taskRef.current) { taskRef.current = learn.sentence; setTask(learn.sentence) }
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
  const sections = pickerSections(eligible, starts, query)
  const cards = [...sections.project, ...sections.most, ...sections.more]
  const showPlain = context.kind === 'project' && (!query.trim() || 'Just a Team A shared board for several agents; no fixed steps.'.toLowerCase().includes(query.toLowerCase()))
  const cardCount = cards.length + (showPlain ? 1 : 0) + 1

  const preview = snapshot.frontDoor?.preview ?? null
  const flow = (preview ?? displayPreview)?.flow ?? null
  const compiled = flow?.compiled.document ?? null
  const inputs = compiled?.format === 'agents' ? compiled.flow.inputs : []
  /** Which of `inputs` the shape's own layout fills from the resolved target — head, base, a pull request — rather than from a person typing. */
  const bound = compiled?.format === 'agents' ? boundInputValues(compiled.flow) : new Map<string, never>()
  const errors = (flow?.problems ?? []).filter((one) => one.level === 'error')
  const startable = preview !== null && !problem && flow !== null && flow.token !== null && compiled?.format === 'agents' && errors.length === 0
  const primary = inputs.find(input => !bound.has(input.id) && input.id !== 'brief')
  const sentenceValid = sentence.trim().length <= 2000 && (primary ? task.trim().length > 0 : true)
  const changeShape = (): void => {
    if (chosen && source) drafts.current.set(`${chosen.origin}:${chosen.id}`, { source, vars, template: templates.current })
    sequence.current += 1
    store.openFrontDoor(context, goal)
    policySequence.current += 1
    setPolicyPending(false)
    setChosen(null)
    setProblem(null)
  }
  const editPolicy = async (policy: FlowPolicy): Promise<void> => {
    const mine = ++sequence.current
    const renderMine = ++policySequence.current
    store.openFrontDoor(context, goal)
    setPolicyPending(true)
    setProblem(null)
    if (flow) setDisplayPreview({ ...(preview ?? displayPreview)!, flow: { ...flow, compiled: { ...flow.compiled, document: { format: 'agents', flow: policy } } } })
    try {
      const rendered = await store.renderShape(policy)
      if (mine !== sequence.current) return
      if (!rendered.source || rendered.issues.length > 0) throw new Error(rendered.issues.map(issue => issue.text).join(' ') || 'That change could not be checked.')
      setSource(rendered.source)
      await runPreview(rendered.source, vars)
    } catch (error) {
      if (mine === sequence.current) setProblem(error instanceof Error ? error.message : 'That change could not be checked.')
    } finally { if (renderMine === policySequence.current) setPolicyPending(false) }
  }

  const start = async (): Promise<void> => {
    if (!preview?.flow.token || !startable || !sentenceValid || briefReading || policyPending || starting) return
    setStarting(true)
    setStartProblem(null)
    try {
      const execution = await store.startFlowGoal({
        root,
        source,
        token: preview.flow.token,
        sentence: sentence.trim() || task.trim().slice(0, 2000) || preview.sentence,
        vars: preview.vars,
        ...(preview.goal ? { goal: preview.goal } : {}),
      })
      if (chosen) recordShapeStart(chosen.id)
      onStarted(execution)
    } catch (error) {
      setStarting(false)
      setStartProblem(error instanceof Error ? error.message : 'The desk did not start this.')
    }
  }

  if (ownShape) {
    return <ShapeEditor root={root} context={context} goal={goal} onClose={() => setOwnShape(false)} onStarted={onStarted} />
  }

  if (plainTeam) return <GoalCreate root={root} task={task} onTaskChange={value => { taskRef.current = value; setTask(value) }} done={sentence} onDoneChange={setSentence} onChangeShape={() => setPlainTeam(false)} onClose={onClose} />

  const icon = (id: string) => id === 'comparison' ? <SideBySideIcon /> : id === 'fix-and-review' ? <PencilIcon /> : id.includes('review') ? <ReviewIcon /> : id === 'investigation' ? <SearchIcon /> : <FlowIcon />
  const project = root.split('/').filter(Boolean).at(-1) ?? root
  let cardIndex = 0
  const group = (name: string, list: readonly FlowEntry[], extra?: ReactNode) => (list.length > 0 || extra) && <section className={styles.section} aria-label={name}>
    <SectionHead name={name} />
    <div className={styles.cards}>{list.map(entry => {
      const index = cardIndex++
      return <Button key={`${entry.origin}-${entry.id}`} variant="choice" size="panel" className={styles.card} data-stretched
        ref={element => { cardRefs.current[index] = element }} aria-label={entry.name}
        title={entry.description ?? undefined} data-selected={activeCard === index ? '' : undefined}
        onFocus={() => setActiveCard(index)} onClick={() => void choose(entry)}>
        <IconTile tint="blue" size="lg">{icon(entry.id)}</IconTile>
        <span className={styles.cardCopy}><Text as="span" role="subject">{entry.name}</Text><Text as="span" role="muted">{entry.problem ?? shapeSummary(entry)}</Text></span>
        <ChevronIcon size={14} />
      </Button>
    })}{extra}</div>
  </section>

  return (
    <Dialog title={chosen ? chosen.name : 'New Team'} icon={chosen ? <IconTile tint="blue">{icon(chosen.id)}</IconTile> : undefined}
      titleAside={<><Chip tone="neutral">{project}</Chip>{chosen && <Button variant="quiet" disabled={starting} onClick={changeShape}>Change</Button>}</>}
      description={!chosen ? <Text role="muted">Pick how the agents work together. You fill in the task next.</Text> : undefined}
      size={chosen ? 'xl' : 'wide'} onClose={onClose}
      footer={chosen ? <><Button variant="default" disabled={!startable || !sentenceValid || briefReading || policyPending || starting} onClick={() => void start()}>{starting ? 'Starting…' : 'Start'}</Button><Button variant="secondary" disabled={starting} onClick={onClose}>Cancel</Button></> : undefined}
      footerAside={chosen ? <Text role="meta">{chosen.id === 'comparison' ? 'You decide whether to merge the winner.' : `The Team opens under ${project} in the sidebar.`}</Text> : undefined}
      footerNavigation={!chosen && <><Button variant="quiet" onClick={() => { onClose(); shell.openAgents() }}>Manage Agents…</Button><span className={styles.solo}><Text as="span" role="muted">Only need one agent?</Text><Button variant="quiet" onClick={() => { onClose(); store.newDraft() }}>New session ⌘N</Button></span></>}
    >
      {!chosen && <div onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
          event.preventDefault()
          const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
          const next = event.target instanceof HTMLInputElement ? 0 : (activeCard + delta + cardCount) % cardCount
          setActiveCard(next); cardRefs.current[next]?.focus()
        } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault(); cardRefs.current[Math.min(activeCard, cardCount - 1)]?.click()
        }
      }} className={styles.picker}>
        <Input autoFocus aria-label="Search shapes" placeholder="Search: review, compare, plan…" value={query} onChange={event => { setQuery(event.target.value); setActiveCard(0) }} />
        {unlisted !== null && <Banner tone="danger" title="These shapes could not be read">{unlisted}</Banner>}
        {group('This project', sections.project)}
        {group('Most used', sections.most)}
        {group('More shapes', sections.more, showPlain && <Button variant="choice" size="panel" className={styles.card} data-stretched ref={element => { cardRefs.current[cards.length] = element }} onFocus={() => setActiveCard(cards.length)} onClick={() => setPlainTeam(true)}>
          <IconTile tone="neutral" size="lg"><TeamIcon /></IconTile><span className={styles.cardCopy}><Text as="span" role="subject">Just a Team</Text><Text as="span" role="muted">A shared board for several agents; no fixed steps.</Text></span><ChevronIcon size={14} />
        </Button>)}
        {query && cards.length === 0 && !showPlain && <Note>No matching shapes.</Note>}
        <Button variant="choice" size="panel" className={styles.card} data-stretched ref={element => { cardRefs.current[cardCount - 1] = element }} onFocus={() => setActiveCard(cardCount - 1)} onClick={() => setOwnShape(true)}>
          <IconTile tone="neutral" size="lg"><PlusIcon /></IconTile><span className={styles.cardCopy}><Text as="span" role="subject">Build your own</Text><Text as="span" role="muted">Steps and rules in an editor; see the file, then start or save it.</Text></span><ChevronIcon size={14} />
        </Button>
      </div>}
      {chosen && <>
        {(primary || context.kind === 'project') && <Field label={chosen.id === 'comparison' ? 'What should both try?' : 'What should they do?'}>
          {control => <Textarea {...control} aria-label={chosen.id === 'comparison' ? 'What should both try?' : 'What should they do?'} value={task} disabled={starting || policyPending} onChange={event => {
            taskRef.current = event.target.value; setTask(event.target.value)
            if (primary) setVar(primary.id, event.target.value)
            else if (compiled?.format === 'agents') void editPolicy({ ...compiled.flow, seed: { ...compiled.flow.seed, title: event.target.value } })
          }} />}
        </Field>}
        {problem && <ActionError>{problem}</ActionError>}
        {compiled?.format === 'agents' && flow && <FlowStart root={root} onChange={() => {}} team={{ flow: compiled.flow, template: templates.current ?? compiled.flow, preview: flow, roster, vars, primary: primary?.id, disabled: starting || policyPending, editingDisabled: starting, onVar: setVar, onReadingChange: setBriefReading, onPolicy: policy => void editPolicy(policy),
          done: <Field label="Done when · optional" error={sentence.trim().length > 2000 ? 'Keep it to 2,000 characters.' : undefined}>
            {control => <Input {...control} aria-label="Done when · optional" value={sentence} disabled={starting} onChange={event => setSentence(event.target.value)} />}
          </Field>,
          details: <>
            {preview && context.kind !== 'project' && <Row title={preview.target.head ? <span title={preview.target.head}>{`${preview.target.label} at ${shortSha(preview.target.head)}`}</span> : preview.target.label} desc={[preview.target.dirty ? 'Not committed — a working-tree snapshot, never a committed head.' : null, preview.target.independence === 'unknown' ? 'Independence from the author is unknown.' : null].filter(Boolean).join(' ') || undefined} />}
            {inputs.filter(input => bound.has(input.id)).map(input => { const value = vars[input.id] ?? ''; const kind = bound.get(input.id); return <Row key={input.id} title={input.label} desc={(kind === 'head' || kind === 'base') && value ? <span title={value}>{shortSha(value)}</span> : value || '—'} /> })}
            <Button variant="quiet" disabled={starting} onClick={() => setEveryTime(true)}>Every time…</Button>
          </>,
        }} />}
        {errors.length > 0 && <Banner tone="danger" title="This will not run yet"><ul>{errors.map(one => <li key={`${one.at}-${one.text}`}>{one.text}</li>)}</ul></Banner>}
        {startProblem && <ActionError>{startProblem}</ActionError>}
      </>}
      {everyTime && chosen && <TriggerCreate root={root} opens={{ flow: chosen.id }} onClose={() => setEveryTime(false)} onSaved={() => setEveryTime(false)} />}
    </Dialog>
  )
}
