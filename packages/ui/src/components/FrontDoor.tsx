import { useCallback, useEffect, useId, useRef, useState } from 'react'

import type { AgentEntry, FlowEntry, FlowExecution, FlowPolicy, GoalView, StartContext } from '@harnessdesk/protocol'

import { ActionError, Banner, Button, Checkbox, Chip, Dialog, DisclosureChevron, Field, Fieldset, FlowCard, FlowCardGrid, FormStack, Input, IssueMark, Note, Row, Rows, SectionHead, Search, SelectedFlow, Text, Textarea } from '../design'
import { pickerSections, quickFlowChoices, readShapeStarts, recordShapeStart, shapeSummary, supportsAttemptCheck, supportsComparisonJudge, withAttemptCheck, withComparisonJudge } from '../lib/team-start'
import { agentName, inForce } from '../lib/agents'
import styles from './FrontDoor.module.css'
import { raceRoleId } from '../lib/flows'
import { shortSha } from '../lib/evidence'
import { boundInputValues } from '../lib/shapes'
import { projectNeedsOpening } from '../lib/workspace-recovery'
import { useSnapshot, useStore } from '../state/context'
import { FlowPreviewReport, FlowStart } from './FlowStart'
import { TriggerCreate } from './TriggerCreate'

/**
 * Every New Team door fills this same form: task, Flow, agents and Done when.
 * A Flow's populated dry run authorizes Start Team; Just a Team retains its
 * partial-create recovery without replacing the dialog or losing the task.
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
  readonly initial?: { readonly id: string; readonly origin?: FlowEntry['origin'] }
  /** Prefills the board-only Team without borrowing a legal Flow file id. */
  readonly initialPlain?: boolean
  readonly initialTask?: string
  /** The current editor bytes, including a Flow that has not been saved. */
  readonly initialSource?: string
  readonly initialDone?: string
  readonly onTaskChange?: (value: string) => void
  readonly onDoneChange?: (value: string) => void
  readonly projectProblem?: string
  readonly onProjectOpened?: () => void
  readonly onClose: () => void
  readonly onStarted: (execution: FlowExecution) => void
}

type Chosen = { readonly kind: 'saved' | 'draft'; readonly id: string; readonly origin: FlowEntry['origin']; readonly name: string }

const choiceKey = (entry: Chosen): string => JSON.stringify([entry.kind, entry.origin, entry.id])

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

export const FrontDoor = ({ context, goal, initial, initialPlain = false, initialTask = '', initialSource, initialDone = '', onTaskChange, onDoneChange, projectProblem, onProjectOpened, onClose, onStarted }: FrontDoorProps) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const root = context.root
  const [entries, setEntries] = useState<readonly FlowEntry[] | null>(null)
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [openingProject, setOpeningProject] = useState(false)
  const [unlisted, setUnlisted] = useState<string | null>(null)
  const [callerProblem, setCallerProblem] = useState(projectProblem ?? null)
  const [roster, setRoster] = useState<ReadonlyMap<string, AgentEntry>>(new Map())
  const [query, setQuery] = useState('')
  const [pickerOpen, setPickerOpen] = useState(!initialPlain || initialSource !== undefined)
  const [allFlows, setAllFlows] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(!!initialDone)
  const advancedId = useId()
  const [activeCard, setActiveCard] = useState(0)
  const pickerRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<HTMLDivElement>(null)
  const selectionRequested = useRef(false)
  // Choosing can render defaults and preflight again after folding the picker.
  // Keep that whole focus handoff separate from the preview's edit generation.
  const choiceGeneration = useRef(0)
  const [initializingChoice, setInitializingChoice] = useState(false)
  const [starts] = useState(readShapeStarts)
  const [task, setTask] = useState(initialTask)
  const taskRef = useRef(initialTask)
  const [plainTeam, setPlainTeam] = useState(initialPlain && initialSource === undefined && !goal)
  const [isolated, setIsolated] = useState(false)
  const [selectedAgents, setSelectedAgents] = useState<ReadonlySet<string>>(new Set())
  const [created, setCreated] = useState<GoalView | null>(null)
  const [taskAdded, setTaskAdded] = useState(false)
  const [seated, setSeated] = useState<ReadonlySet<string>>(new Set())
  const [plainDryRun, setPlainDryRun] = useState(false)
  const [dryRunOpen, setDryRunOpen] = useState(false)
  const [briefReading, setBriefReading] = useState(false)
  const [policyPending, setPolicyPending] = useState(false)
  const [readingAccounts, setReadingAccounts] = useState(false)
  const policySequence = useRef(0)
  const [displayPreview, setDisplayPreview] = useState<import('@harnessdesk/protocol').FrontDoorPreview | null>(null)
  const templates = useRef<FlowPolicy | null>(null)
  const drafts = useRef(new Map<string, { source: string; vars: Readonly<Record<string, string>>; template: FlowPolicy | null }>())
  const [chosen, setChosen] = useState<Chosen | null>(null)
  const [everyTime, setEveryTime] = useState(false)
  const [source, setSource] = useState('')
  const [vars, setVars] = useState<Readonly<Record<string, string>>>({})
  const [sentence, setSentence] = useState(initialDone)
  const [problem, setProblem] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startProblem, setStartProblem] = useState<string | null>(null)
  const startFailureRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!startProblem) return
    startFailureRef.current?.focus({ preventScroll: true })
    startFailureRef.current?.scrollIntoView({ block: 'nearest' })
  }, [startProblem])
  const sequence = useRef(0)
  const initialTried = useRef(false)

  // The one open request this dialog is for. Closing — an unmount, same as
  // choosing a different shape mid-flight elsewhere — retires whatever
  // `previewFrontDoor` call is still in the air.
  useEffect(() => {
    // A lifecycle replay retires the first read too; allow its replacement
    // to select the initial source while the sequence rejects the old reply.
    initialTried.current = false
    store.openFrontDoor(context, goal)
    return () => { sequence.current += 1; store.closeFrontDoor() }
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
  }, [root, store, catalogRevision])

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
    async (next: FlowEntry | Chosen, suppliedSource?: string): Promise<void> => {
      const entry: Chosen = 'kind' in next ? next : { kind: 'saved', id: next.id, origin: next.origin, name: next.name }
      if (created || starting) return
      const choice = ++choiceGeneration.current
      setInitializingChoice(true)
      if (chosen && source) drafts.current.set(choiceKey(chosen), { source, vars, template: templates.current })
      setPlainTeam(false)
      setPickerOpen(false)
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
      setChosen(entry)
      setSource('')
      setVars({})
      templates.current = null
      setDisplayPreview(null)
      setBriefReading(false)
      setPolicyPending(false)
      setReadingAccounts(false)
      setProblem(null)
      setStartProblem(null)
      try {
        const draft = drafts.current.get(choiceKey(entry))
        const firstUse = !draft && suppliedSource === undefined
        // Discovery can trail the workspace. Its existing bounded read must
        // settle before an automatic comparison can redeem its preview.
        if (firstUse && entry.id === 'comparison' && store.getSnapshot().runtimes.some(one => !store.getSnapshot().accountsByRuntime[one.id])) {
          setReadingAccounts(true)
          await store.loadAccounts()
          if (mine !== sequence.current) return
          setReadingAccounts(false)
        }
        if (entry.kind === 'draft' && suppliedSource === undefined && !draft) throw new Error('This draft Flow has no source to check.')
        let text = suppliedSource ?? draft?.source ?? await store.flowSource(root, entry.id, entry.origin)
        if (mine !== sequence.current) return
        setSource(text)
        // A first, throwaway dry run with no variables typed — only to learn
        // what this shape asks for and which of that the chosen context
        // already answers, so its real defaults can be previewed for real.
        const learn = await store.previewFrontDoor({ context, source: text, vars: {}, ...(goal ? { goal } : {}) })
        if (mine !== sequence.current) return
        const policy = learn.flow.compiled.document.format === 'agents' ? learn.flow.compiled.document.flow : null
        templates.current = draft?.template ?? policy
        setDisplayPreview(learn)
        if (entry.kind === 'draft' && policy) setChosen({ ...entry, name: policy.name })
        // The suggestion is a first-use default. A saved check or a draft
        // the person cleared remains theirs, including an empty command.
        let defaultsPolicy = policy
        if (firstUse && policy && supportsComparisonJudge(policy)) defaultsPolicy = withComparisonJudge(policy, policy, null)
        const attemptRole = policy && raceRoleId(policy)
        if (firstUse && defaultsPolicy && attemptRole) {
          const current = store.getSnapshot()
          const signedIn = current.runtimes.filter(one => current.accountsByRuntime[one.id]?.accounts.length)
          if (signedIn.length) defaultsPolicy = { ...defaultsPolicy, roles: defaultsPolicy.roles.map(role =>
            role.id === attemptRole && role.kind === 'agent' && role.seats.length === 0
              ? { ...role, count: 2, seats: [signedIn[0]!, signedIn[1] ?? signedIn[0]!].map(one => ({ runtime: one.id })) }
              : role) }
        }
        if (firstUse && defaultsPolicy && learn.projectCheckCommand && supportsAttemptCheck(defaultsPolicy) && !defaultsPolicy.roles.some(role => role.kind === 'check')) defaultsPolicy = withAttemptCheck(defaultsPolicy, policy!, learn.projectCheckCommand)
        const inputs = learn.flow.compiled.document.format === 'agents' ? learn.flow.compiled.document.flow.inputs : []
        const primary = inputs.find(input => input.id !== 'brief' && (!policy || !boundInputValues(policy).has(input.id)))
        if (!primary && context.kind === 'project' && taskRef.current && defaultsPolicy && defaultsPolicy.seed.title !== taskRef.current) {
          defaultsPolicy = { ...defaultsPolicy, seed: { ...defaultsPolicy.seed, title: taskRef.current } }
        }
        const defaults = { ...Object.fromEntries(inputs.map((input) => [input.id, learn.vars[input.id] ?? input.default ?? ''])), ...draft?.vars }
        if (primary && taskRef.current) defaults[primary.id] = taskRef.current
        else if (primary) { taskRef.current = defaults[primary.id] ?? ''; setTask(taskRef.current) }
        else if (context.kind === 'project' && !taskRef.current) { taskRef.current = policy?.seed.title ?? learn.sentence; setTask(taskRef.current) }
        setVars(defaults)
        if (defaultsPolicy && defaultsPolicy !== policy) {
          // Expose the pending policy and inputs together so continued task
          // typing preserves both the suggested options and other defaults.
          setDisplayPreview({ ...learn, flow: { ...learn.flow, compiled: { ...learn.flow.compiled, document: { format: 'agents', flow: defaultsPolicy } } } })
          setPolicyPending(true)
          const rendered = await store.renderShape(defaultsPolicy)
          if (mine !== sequence.current) return
          if (rendered.issues.length > 0 || !rendered.source) throw new Error(rendered.issues.map(issue => issue.text).join(' ') || 'That check could not be prepared.')
          text = rendered.source
          setSource(text)
          setPolicyPending(false)
        }
        if (inputs.length > 0 || text !== learn.source) await runPreview(text, defaults)
      } catch (error) {
        if (mine !== sequence.current) return
        setPolicyPending(false)
        setReadingAccounts(false)
        setProblem(error instanceof Error ? error.message : 'That shape could not be read.')
      } finally { if (choice === choiceGeneration.current) setInitializingChoice(false) }
    },
    [context, goal, root, runPreview, store, chosen, source, vars, created, starting],
  )

  useEffect(() => {
    if (initialTried.current || plainTeam) return
    if (initialSource !== undefined) {
      initialTried.current = true
      const match = entries?.find(one => one.id === initial?.id && (initial?.origin === undefined || one.origin === initial.origin))
      void choose(match ?? { kind: initial ? 'saved' : 'draft', id: initial?.id ?? '', origin: initial?.origin ?? 'project', name: 'Draft Flow' }, initialSource)
    } else if (initial && entries && !chosen) {
      initialTried.current = true
      const match = entries.find(one => one.id === initial.id && (initial.origin === undefined || one.origin === initial.origin))
      if (match) void choose(match)
      else setUnlisted('That Flow is not available in this project.')
    }
  }, [initial, initialSource, entries, chosen, choose, plainTeam])

  useEffect(() => { if (plainTeam) void store.loadAgents() }, [plainTeam, store])

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
  const completeCatalog = allFlows || !!query.trim()
  const cards = completeCatalog ? [...sections.project, ...sections.most, ...sections.more] : quickFlowChoices(eligible, starts)
  const showPlain = context.kind === 'project' && !goal && (!query.trim() || 'Just a Team A shared board for several agents; no fixed steps.'.toLowerCase().includes(query.toLowerCase()))
  const draftCard = chosen && (chosen.kind === 'draft' || !eligible.some(entry => entry.id === chosen.id && entry.origin === chosen.origin)) ? chosen : null
  const cardCount = cards.length + (showPlain ? 1 : 0) + (draftCard ? 1 : 0)
  const pickerCards = (): HTMLButtonElement[] => [...pickerRef.current?.querySelectorAll<HTMLButtonElement>('[data-slot="flow-card"]') ?? []]
  const changeFlow = (): void => { setAllFlows(true); setQuery(''); setPickerOpen(true) }
  useEffect(() => {
    if (pickerOpen && (chosen || plainTeam)) pickerRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
  }, [pickerOpen])
  useEffect(() => {
    if (!pickerOpen && !initializingChoice && !policyPending && !readingAccounts && selectionRequested.current) {
      const change = selectedRef.current?.querySelector<HTMLButtonElement>('button')
      if (!change || change.disabled) return
      const active = document.activeElement
      // A removed/disabled picker can leave focus on the document or dialog.
      // Any other focused element belongs to the person's current interaction.
      const abandoned = !active || active === document.body || active === document.documentElement ||
        active.getAttribute('role') === 'dialog' || active.hasAttribute('data-base-ui-focus-guard')
      if (abandoned || active === change) change.focus()
      selectionRequested.current = false
    }
  }, [pickerOpen, initializingChoice, policyPending, readingAccounts])

  const preview = snapshot.frontDoor?.preview ?? null
  const flow = (preview ?? displayPreview)?.flow ?? null
  const compiled = flow?.compiled.document ?? null
  const inputs = compiled?.format === 'agents' ? compiled.flow.inputs : []
  /** Which of `inputs` the shape's own layout fills from the resolved target — head, base, a pull request — rather than from a person typing. */
  const bound = compiled?.format === 'agents' ? boundInputValues(compiled.flow) : new Map<string, never>()
  const errors = (flow?.problems ?? []).filter((one) => one.level === 'error')
  const startable = preview !== null && !readingAccounts && !openingProject && !problem && flow !== null && flow.token !== null && compiled?.format === 'agents' && errors.length === 0
  const primary = inputs.find(input => !bound.has(input.id) && input.id !== 'brief')
  const sentenceValid = sentence.trim().length <= 2000 && (primary || context.kind === 'project' ? task.trim().length > 0 : true)
  const startReason = starting ? 'Starting the Team…'
    : openingProject ? 'Opening the project…'
    : problem ? 'Resolve the shape error first.'
    : readingAccounts ? 'Reading signed-in runtimes…'
    : !flow ? 'Reading the shape…'
    : !sentenceValid ? task.trim() ? 'Keep Done when to 2,000 characters.' : 'Add a task first.'
    : briefReading ? 'Reading the attached brief…'
    : policyPending || !preview ? 'Checking the seats and inputs…'
    : errors.length ? 'Resolve the dry-run errors above.'
    : !startable ? 'Resolve the dry-run requirements first.' : null
  const choosePlainTeam = (): void => {
    if (created || starting) return
    choiceGeneration.current += 1
    setInitializingChoice(false)
    if (chosen && source) drafts.current.set(choiceKey(chosen), { source, vars, template: templates.current })
    sequence.current += 1
    policySequence.current += 1
    store.openFrontDoor(context, goal)
    setChosen(null)
    setPlainTeam(true)
    setPickerOpen(false)
    setBriefReading(false)
    setPolicyPending(false)
    setReadingAccounts(false)
    setProblem(null)
    setStartProblem(null)
  }
  const editPolicy = async (policy: FlowPolicy, nextVars = vars): Promise<void> => {
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
      await runPreview(rendered.source, nextVars)
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
        source: preview.source,
        token: preview.flow.token,
        sentence: sentence.trim() || task.trim().slice(0, 2000) || preview.sentence,
        vars: preview.vars,
        ...(preview.goal ? { goal: preview.goal } : {}),
      })
      if (chosen?.kind === 'saved') recordShapeStart(chosen.id)
      onStarted(execution)
    } catch (error) {
      setStarting(false)
      setStartProblem(error instanceof Error ? error.message : 'The desk did not start this.')
    }
  }

  const plainWords = sentence.trim() || task.trim()
  const taskIssue = plainTeam && !sentence.trim() && task.trim().length > 2000 ? 'Keep the task to 2,000 characters.' : undefined
  const doneIssue = sentence.trim().length > 2000 ? 'Keep Done when to 2,000 characters.' : undefined
  const plainValid = plainWords.length > 0 && plainWords.length <= 2000
  const plainAgents = inForce(snapshot.agents ?? [])
  const submitPlain = async (): Promise<void> => {
    if (!plainValid || starting || openingProject || goal) return
    setStarting(true)
    setStartProblem(null)
    let team = created
    try {
      if (!team) {
        team = await store.startTeam({ root, sentence: plainWords, checkout: isolated ? 'isolated' : 'shared' })
        setCreated(team)
      }
      if (task.trim() && !taskAdded) {
        await store.teamAdd(team.goal.id, { title: task.trim() })
        setTaskAdded(true)
      }
      const done = new Set(seated)
      const failures: string[] = []
      for (const agent of selectedAgents) {
        if (done.has(agent)) continue
        try {
          await store.seatGoal({ goal: team.goal.id, agent })
          done.add(agent)
          setSeated(new Set(done))
        } catch (error) { failures.push(error instanceof Error ? error.message : String(error)) }
      }
      if (failures.length) { setStartProblem(failures.join(' ')); return }
      store.openGoal(team.goal.id)
      onClose()
    } catch (error) {
      setStartProblem(error instanceof Error ? error.message : 'The desk did not create this Team.')
    } finally { setStarting(false) }
  }
  const project = root.split('/').filter(Boolean).at(-1) ?? root
  const openProject = async (): Promise<void> => {
    if (openingProject) return
    const mine = ++sequence.current
    setOpeningProject(true)
    try {
      if (!await store.openWorkspace(root) || mine !== sequence.current) return
      setStartProblem(null)
      setCallerProblem(null)
      onProjectOpened?.()
      // Relearn the shape with a fresh token; keep edits, including its policy.
      if (chosen) {
        if (source) drafts.current.set(choiceKey(chosen), { source, vars, template: templates.current })
        await choose(chosen)
      }
      setCatalogRevision(value => value + 1)
    } finally { setOpeningProject(false) }
  }
  const recovery = (text: string) => projectNeedsOpening(text)
    ? <Button variant="secondary" disabled={openingProject} onClick={() => void openProject()}>{openingProject ? 'Opening…' : `Open ${project}`}</Button>
    : undefined
  const failure = (text: string) => recovery(text)
    ? <Banner tone="danger" role="alert" actions={recovery(text)}>{text}</Banner>
    : <ActionError>{text}</ActionError>
  const flowCard = (entry: FlowEntry) => <FlowCard key={`${entry.origin}-${entry.id}`} name={entry.name}
      aria-label={entry.name} title={entry.description ?? entry.name}
      origin={entry.origin === 'project' ? project : entry.origin === 'builtin' ? 'Built in' : 'Personal'}
      policy={chosen?.kind === 'saved' && chosen.id === entry.id && chosen.origin === entry.origin && compiled?.format === 'agents' ? compiled.flow : entry.policy}
      summary={entry.problem ?? shapeSummary(entry)} selected={chosen?.kind === 'saved' && chosen.id === entry.id && chosen.origin === entry.origin}
      disabled={starting || policyPending || readingAccounts || !!created} onClick={() => { selectionRequested.current = true; void choose(entry) }} />
  const plainCard = <FlowCard empty name="Just a Team" aria-label="Just a Team" origin="Built in" summary="A shared board for several agents; no fixed steps." selected={plainTeam} disabled={starting || !!created || policyPending || readingAccounts} onClick={() => { selectionRequested.current = true; choosePlainTeam() }} />
  const group = (name: string, list: readonly FlowEntry[]) => list.length > 0 && <section className={styles.section} aria-label={name}>
    <SectionHead level="label" name={name} />
    <FlowCardGrid>{list.map(flowCard)}</FlowCardGrid>
  </section>
  const locked = starting || !!created
  const reason = plainTeam
    ? starting ? 'Starting the Team…' : openingProject ? 'Opening the project…' : !plainValid ? taskIssue ?? doneIssue ?? 'Add a task first.' : null
    : chosen ? startReason : 'Choose a Flow first.'
  const canStart = plainTeam ? plainValid && !openingProject && !starting : !!chosen && startable && sentenceValid && !briefReading && !policyPending && !starting
  const dryRun = (): void => {
    if (plainTeam) setPlainDryRun(true)
    else if (source) { setDryRunOpen(true); void runPreview(source, vars) }
  }

  return (
    <Dialog title="New Team" titleAside={<Chip tone="neutral">{project}</Chip>}
      size="wide" onClose={onClose}
      footer={<>
        <Button variant="default" aria-describedby={reason ? 'team-start-reason' : undefined} disabled={!canStart} onClick={() => void (plainTeam ? submitPlain() : start())}>{starting ? 'Starting…' : created ? 'Retry unfinished' : 'Start Team'}</Button>
        <Button variant="secondary" disabled={starting} onClick={onClose}>Cancel</Button>
      </>}
      footerAside={reason && <Note id="team-start-reason" role="status">{reason}</Note>}
      footerNavigation={<><Text as="span" role="muted">Only need one agent?</Text><Button variant="quiet" disabled={locked} onClick={() => { onClose(); store.newDraft() }}>New session ⌘N</Button></>}
    >
      <FormStack>
        <Field label={chosen?.id === 'comparison' ? 'What should both try?' : 'What should they do?'} error={taskIssue ? <IssueMark message={taskIssue} tone="danger" /> : undefined}>
          {control => <Textarea {...control} aria-label={chosen?.id === 'comparison' ? 'What should both try?' : 'What should they do?'} autoFocus value={task} disabled={locked || readingAccounts} onChange={event => {
            const next = event.target.value
            taskRef.current = next; setTask(next); onTaskChange?.(next); setPlainDryRun(false)
            if (primary && !plainTeam) {
              if (policyPending && compiled?.format === 'agents') {
                const nextVars = { ...vars, [primary.id]: next }
                setVars(nextVars)
                // Carry the in-flight policy edit forward with this task;
                // previewing the old source would otherwise discard it.
                void editPolicy(compiled.flow, nextVars)
              } else setVar(primary.id, next)
            }
            else if (!plainTeam && compiled?.format === 'agents') void editPolicy({ ...compiled.flow, seed: { ...compiled.flow.seed, title: next } })
          }} />}
        </Field>
        {!pickerOpen && (chosen || plainTeam) && <div ref={selectedRef}><SelectedFlow name={plainTeam ? 'Just a Team' : chosen!.name}
          origin={plainTeam || chosen?.origin === 'builtin' ? 'Built in' : chosen?.kind === 'draft' ? 'Draft' : chosen?.origin === 'project' ? project : 'Personal'}
          policy={compiled?.format === 'agents' ? compiled.flow : undefined} empty={plainTeam}
          showGraph={plainTeam || !flow}
          loading={!plainTeam && initializingChoice && !compiled && !problem}
          disabled={locked || policyPending || readingAccounts} onChange={changeFlow} /></div>}
        {!pickerOpen && unlisted !== null && <Banner tone="danger" title="These Flows could not be read" actions={recovery(unlisted)}>{unlisted}</Banner>}
        {pickerOpen && <section className={styles.picker} aria-label="Flow" ref={pickerRef} onFocusCapture={event => {
          const index = pickerCards().indexOf(event.target as HTMLButtonElement)
          if (index >= 0) setActiveCard(index)
        }} onKeyDown={event => {
          if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) {
            event.preventDefault()
            const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
            const next = event.target instanceof HTMLInputElement ? 0 : (activeCard + delta + cardCount) % cardCount
            setActiveCard(next); pickerCards()[next]?.focus()
          } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
            event.preventDefault(); pickerCards()[Math.min(activeCard, cardCount - 1)]?.click()
          } else if (event.key === 'Enter' && event.target instanceof HTMLButtonElement && event.target.dataset.slot === 'flow-card') {
            event.preventDefault(); event.target.click()
          }
        }}>
          <SectionHead level="label" name="Flow" action={<>
            {(chosen || plainTeam) && <Button variant="outline" size="sm" onClick={() => { selectionRequested.current = true; setPickerOpen(false) }}>Keep selected Flow</Button>}
            <Button variant="outline" size="sm" disabled={locked || policyPending || readingAccounts} onClick={() => { store.openDestination({ kind: 'flows', root, id: null, origin: null, start: { context, ...(goal ? { goal } : {}), task, done: sentence } }); onClose() }}>Build your own</Button>
          </>} />
          <Search label="Search Flows" placeholder="Search Flows…" value={query} onChange={value => { setQuery(value); setActiveCard(0) }} />
          {unlisted !== null && <Banner tone="danger" title="These Flows could not be read" actions={recovery(unlisted)}>{unlisted}</Banner>}
          {entries === null && !unlisted && <div aria-label="Loading Flows" aria-busy="true"><Rows><Row title="Reading Flows…" /><Row title="Reading project choices…" /></Rows></div>}
          {completeCatalog ? <>{group('This project', sections.project)}{group('Most used', sections.most)}{group('More Flows', sections.more)}</> : <FlowCardGrid>{cards.map(flowCard)}{showPlain && plainCard}</FlowCardGrid>}
          {draftCard && <FlowCardGrid><FlowCard name={draftCard.name} aria-label={draftCard.name} origin="Draft" policy={compiled?.format === 'agents' ? compiled.flow : undefined} summary={compiled?.format === 'agents' ? compiled.flow.summary ?? compiled.flow.description ?? '' : ''} selected disabled={locked || policyPending || readingAccounts} onClick={() => {}} /></FlowCardGrid>}
          {completeCatalog && showPlain && <FlowCardGrid>{plainCard}</FlowCardGrid>}
          {!completeCatalog && eligible.length > cards.length && <div><Button variant="quiet" size="sm" onClick={() => setAllFlows(true)}>All Flows</Button></div>}
          {query && cards.length === 0 && !showPlain && <Note>No matching Flows.</Note>}
        </section>}
        {chosen && <>
          {!flow && !problem && <section aria-label="Loading Team form" aria-busy="true"><Rows>
            {(chosen.id === 'comparison' ? ['Attempt A', 'Attempt B'] : ['Agents', 'Options']).map(label => <Row key={label} title={label} control={<Input aria-label={`${label} loading`} disabled placeholder="…" />} />)}
          </Rows></section>}
          {problem && failure(problem)}
          {compiled?.format === 'legacy' && <Banner tone="warning">Update this Flow from its Flows page before it can start a Team here.</Banner>}
          {compiled?.format === 'agents' && flow && <FlowStart root={root} onChange={() => {}} team={{ flow: compiled.flow, template: templates.current ?? compiled.flow, preview: flow, roster, vars, primary: primary?.id, disabled: starting || policyPending, editingDisabled: starting, onVar: setVar, onReadingChange: setBriefReading, onPolicy: policy => void editPolicy(policy),
            details: <>
              {preview && context.kind !== 'project' && <Row title={preview.target.head ? <span title={preview.target.head}>{`${preview.target.label} at ${shortSha(preview.target.head)}`}</span> : preview.target.label} desc={[preview.target.dirty ? 'Not committed — a working-tree snapshot, never a committed head.' : null, preview.target.independence === 'unknown' ? 'Independence from the author is unknown.' : null].filter(Boolean).join(' ') || undefined} />}
              {inputs.filter(input => bound.has(input.id)).map(input => { const value = vars[input.id] ?? ''; const kind = bound.get(input.id); return <Row key={input.id} title={input.label} desc={(kind === 'head' || kind === 'base') && value ? <span title={value}>{shortSha(value)}</span> : value || '—'} /> })}
              {initialSource === undefined && <Button variant="quiet" disabled={starting} onClick={() => setEveryTime(true)}>Every time…</Button>}
            </>,
          }} />}
          {errors.length > 0 && <Banner tone="danger" title="This will not run yet" actions={recovery(errors.map(one => one.text).join(' '))}><ul>{errors.map(one => <li key={`${one.at}-${one.text}`}>{one.text}</li>)}</ul></Banner>}
        </>}
        {plainTeam && <>
          <Fieldset legend="Who does what"><Rows>{plainAgents.map(agent => <Row key={agent.id} title={agentName(agent)} control={<Checkbox checked={selectedAgents.has(agent.id)} disabled={seated.has(agent.id) || starting} aria-label={`Seat ${agentName(agent)}`} onCheckedChange={checked => {
            const next = new Set(selectedAgents); if (checked) next.add(agent.id); else next.delete(agent.id)
            setSelectedAgents(next); setPlainDryRun(false)
          }} />} />)}</Rows>{plainAgents.length === 0 && <Note>Add work or seat an Agent after this Team is created.</Note>}</Fieldset>
          <Rows><Row title="Use an isolated checkout" desc="New Seats get retained worktrees, ports and browser profiles." control={<Checkbox checked={isolated} disabled={locked} aria-label="Use an isolated checkout" onCheckedChange={next => { setIsolated(next === true); setPlainDryRun(false) }} />} /></Rows>
        </>}
        {(chosen || plainTeam) && <section className={styles.section} aria-label="Completion and dry run">
        <div><Button variant="quiet" size="inline-link" aria-expanded={advancedOpen} aria-controls={advancedId} onClick={() => setAdvancedOpen(open => !open)}><DisclosureChevron open={advancedOpen} size="sm" />Completion and dry run</Button></div>
        <div id={advancedId} className={advancedOpen ? styles.section : undefined} hidden={!advancedOpen}>
        <Field label="Done when · optional" error={doneIssue ? <IssueMark message={doneIssue} tone="danger" /> : undefined}>
          {control => <Input {...control} aria-label="Done when · optional" value={sentence} disabled={locked} onChange={event => { setSentence(event.target.value); onDoneChange?.(event.target.value); setPlainDryRun(false) }} />}
        </Field>
        <div><Button variant="secondary" size="sm" disabled={starting || openingProject || policyPending || readingAccounts || (!plainTeam && !source)} onClick={dryRun}>Dry run</Button></div>
        {!plainTeam && dryRunOpen && compiled?.format === 'agents' && flow && <section aria-label="Dry run"><SectionHead level="label" name="Dry run" />{!preview && <Note role="status">Checking the seats and inputs…</Note>}<FlowPreviewReport preview={flow} flow={compiled.flow} roster={roster} vars={vars} warnings={flow.problems.filter(one => one.level === 'warning')} /></section>}
        {plainTeam && plainDryRun && <Note role="status">No fixed steps. The Team opens with a board and chat{selectedAgents.size ? ` and ${selectedAgents.size} selected Agent${selectedAgents.size === 1 ? '' : 's'}` : ''}. {isolated ? 'New Seats use isolated checkouts.' : 'Seats share the project checkout.'}</Note>}
        </div></section>}
        {plainTeam && callerProblem && !startProblem && callerProblem !== unlisted && failure(callerProblem)}
        {startProblem && <div ref={startFailureRef} tabIndex={-1}>{failure(startProblem)}</div>}
      </FormStack>
      {everyTime && chosen && <TriggerCreate root={root} opens={{ flow: chosen.id }} onClose={() => setEveryTime(false)} onSaved={() => setEveryTime(false)} />}
    </Dialog>
  )
}
