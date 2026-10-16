import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  AgentEntry, AuthoringDocument, AuthoringIssue, FlowExecution, FlowPolicy, FlowPolicyRole, FlowPolicyRule, FrontDoorPreview, StartContext,
} from '@harnessdesk/protocol'

import {
  ActionError, Banner, BoardMenuButton, Button, Dialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  Field, Input, Note, NoteList, Row, Rows, SectionHead, Tabs, TabsList, TabsTrigger, Textarea,
  ConfirmDialog, FlowCanvasToolbar, FlowCanvasWorkspace, FlowCanvasSurface, FlowCanvasContent, MenuItem, ToolSection, ToolBody, ToolProse, ToolBodyControls, ToolFold, KeyValue, KeyValueRow,
} from '../design'
import { useSnapshot, useStore } from '../state/context'
import { shortSha } from '../lib/evidence'
import { boundInputIds, boundInputValues, defaultRole, defaultRule, emptyShapePolicy, renameRoleReferences, roleRemovable, uniqueId, withGraphPositions } from '../lib/shapes'
import { PlusIcon, MoveDownIcon, MoveUpIcon, TrashIcon, CopyIcon, PencilIcon, PanelRightIcon } from './Icons'
import { FlowPreviewReport } from './FlowStart'
import { ShapeGraph } from './ShapeGraph'
import { ShapeRule } from './ShapeRule'
import { ShapeSave } from './ShapeSave'
import { ShapeStep } from './ShapeStep'
import { TriggerCreate } from './TriggerCreate'
import { ProjectTriggers } from './ProjectTriggers'
import { TriggerSettings } from './TriggerSettings'
import { useTopBar } from '../panels/top-bar'
import { useDestinationActive, useDestinationPage } from '../panels/destination-page'
import { matchingFlowRuns, useFlowRunCoverage } from '../lib/flow-catalogue'

/**
 * Your own shape: an ordered editor of a real flow policy, and the exact,
 * host-normalized source it writes — never a second renderer grammar. Every
 * choice here maps to the same `FlowPolicy` the dry run and the engine
 * already understand: adding a step or a rule mutates that object, asks the
 * host to render it (`authoring/shape/render`), and only replaces the source
 * pane once the host says the result reads back exactly as itself.
 *
 * Two directions keep one document in sync, never two: an ordered edit
 * renders forward into source; an edit typed straight into the source pane
 * is parsed back (through the same dry run FrontDoor already runs) into the
 * ordered form. A source that does not parse to the current format keeps the
 * last valid ordered form on screen, marked stale, with Start disabled —
 * nothing here guesses a fix or silently drops what does not parse.
 */
export interface ShapeEditorProps {
  readonly root: string
  readonly context: StartContext
  /** The empty Goal this editor's own dry run and Start reuse, at the revision it was seen at — the same front-door reuse a catalogued shape already gets. */
  readonly goal?: { readonly id: string; readonly revision: number }
  readonly document?: AuthoringDocument
  readonly initialSource?: string
  readonly onClose: () => void
  readonly onStarted: (execution: FlowExecution) => void
  readonly presentation?: 'dialog' | 'page'
  readonly onStartTeam?: (source: string) => void
  readonly onUpdate?: () => void
}
type ShapeHistory = { readonly kind: 'source'; readonly source: string } | { readonly kind: 'policy'; readonly policy: FlowPolicy }

export const ShapeEditor = ({ root, context, goal, document: initialDocument, initialSource, onClose, onStarted, presentation = 'dialog', onStartTeam, onUpdate }: ShapeEditorProps) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const page = presentation === 'page'
  const active = useDestinationActive()
  const countKnown = useFlowRunCoverage(page && active)
  const sequence = useRef(0)
  const activeOwner = useRef(!page || active)
  const activeGeneration = useRef(0)
  if (activeOwner.current !== (!page || active)) {
    activeOwner.current = !page || active
    activeGeneration.current++
    sequence.current++
  }
  const [previewGeneration, setPreviewGeneration] = useState(-1)
  /** An ordered edit still awaiting its own rendered source survives a trip away. */
  const pendingPolicy = useRef<FlowPolicy | null>(null)
  const [document, setDocument] = useState(initialDocument)
  const [tab, setTab] = useState<'steps' | 'graph' | 'source'>(page ? 'graph' : 'steps')
  const [rail, setRail] = useState(true)
  const [history, setHistory] = useState<readonly ShapeHistory[]>([])
  const [rename, setRename] = useState(false)
  const [name, setName] = useState('')
  const [duplicate, setDuplicate] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showDryRun, setShowDryRun] = useState(false)
  const [selectedRole, setSelectedRole] = useState<string | null>(null)
  const [selectedRule, setSelectedRule] = useState<string | null>(null)
  const [source, setSource] = useState<string>(document?.source ?? initialSource ?? '')
  const [loadingDraft, setLoadingDraft] = useState(document === undefined && initialSource === undefined)
  const [policy, setPolicy] = useState<FlowPolicy | null>(null)
  const policyRef = useRef<FlowPolicy | null>(null)
  const [stale, setStale] = useState(false)
  const [formIssues, setFormIssues] = useState<readonly AuthoringIssue[]>([])
  const [roster, setRoster] = useState<ReadonlyMap<string, AgentEntry>>(new Map())
  const [vars, setVarsState] = useState<Readonly<Record<string, string>>>({})
  /**
   * The vars a person actually typed, read by every dry run and by Start —
   * never `preview.vars`, which only ever echoes what the *last* request
   * sent and goes stale the moment someone types again before that request
   * returns. A ref, not just the state above, because `runDryRun` is called
   * from effects and callbacks whose own closures would otherwise see the
   * value they captured rather than the one on screen right now.
   */
  const varsRef = useRef<Readonly<Record<string, string>>>({})
  const setVars = (next: Readonly<Record<string, string>>): void => {
    varsRef.current = next
    setVarsState(next)
  }
  const [sentence, setSentence] = useState('')
  const sentenceTouched = useRef(false)
  const [preview, setPreview] = useState<FrontDoorPreview | null>(null)
  /** True from the moment a dry run is asked for until a token bound to the vars it was asked with actually lands — never true→false across a re-preview a filled-in default triggered. */
  const [previewPending, setPreviewPending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startProblem, setStartProblem] = useState<string | null>(null)
  const [showSave, setShowSave] = useState(false)
  const saveReadSequence = useRef(0)
  const [saveReadPending, setSaveReadPending] = useState(false)
  const [saveConflict, setSaveConflict] = useState<{ readonly document: AuthoringDocument | null; readonly message: string } | null>(null)
  const [saveForTrigger, setSaveForTrigger] = useState(false)
  const [savedFlowId, setSavedFlowId] = useState<string | null>(document?.target.kind === 'flow' ? document.target.id : null)
  const [everyTime, setEveryTime] = useState(false)
  useEffect(() => {
    if (!page || active) return
    setShowSave(false)
    setShowDryRun(false)
    setRename(false)
    setDeleting(false)
    setDuplicate(false)
    setSaveForTrigger(false)
  }, [active, page])
  /**
   * The shape's source, mirrored the same way `varsRef` mirrors `vars`:
   * `editPolicy` is memoized against neither, so its own closure would
   * otherwise see whatever `source` was when it was last recreated, not the
   * last known-good one on screen when a deferred var edit needs it flushed.
   */
  const sourceRef = useRef<string>(source)
  const setSourceBoth = (text: string): void => {
    sourceRef.current = text
    setSource(text)
  }
  /**
   * Whether a step or rule edit's own `authoring/shape/render` is still out —
   * narrower than `previewPending`, which a plain dry run also sets.
   *
   * Derived, never set directly, so it cannot stick: `renderIssued` counts
   * every `editPolicy` call, `renderSettled` is a high-water mark carried to
   * at least that call's own number on *every* exit path — success, failure,
   * or one this file's own `sequence` check finds superseded — so an edit
   * that answers stale (its `mine` no longer the current `sequence`, because
   * something unrelated to any other step edit moved it, `editSource`, say)
   * still marks its own render settled. A plain boolean cleared only on the
   * paths that also apply the render's result stayed true forever the moment
   * every edit still in flight happened to settle stale — from then on a
   * typed var deferred here (`varEditPending`) never got its own dry run,
   * and Start never saw it.
   */
  const renderIssued = useRef(0)
  const renderSettled = useRef(0)
  const renderPending = (): boolean => renderIssued.current !== renderSettled.current
  /** A var typed while `renderPending()` was true, not yet given its own dry run. */
  const varEditPending = useRef(false)

  useEffect(() => {
    store.agentsIn(root).then(
      (list) => setRoster(new Map(list.map((entry) => [entry.id, entry]))),
      () => {
        // An unread roster leaves an Agent step with no rows to choose from.
      },
    )
  }, [root, store])

  const runDryRun = useCallback(
    async (text: string): Promise<void> => {
      if (!activeOwner.current) return
      const mine = ++sequence.current
      setProblem(null)
      setPreviewPending(true)
      try {
        const dry = await store.previewFrontDoor({ context, source: text, vars: varsRef.current, ...(goal ? { goal } : {}) }, { publish: !page })
        if (!activeOwner.current || mine !== sequence.current) return
        const parsedDocument = dry.flow.compiled.document
        if (parsedDocument.format === 'agents') {
          policyRef.current = parsedDocument.flow
          setPolicy(parsedDocument.flow)
          setStale(false)
          // Fill a value only for an input with none yet — an input freshly
          // added by a step or rule edit. A value already there, typed or
          // filled earlier, is never overwritten: that is what reset every
          // keystroke back to the input's own default the moment the dry run
          // it triggered came back. A bound input (a branch, a base, a head,
          // a pull request) takes the value this very response resolved it
          // to, from the start target — never its own YAML default, which is
          // not what the host bound it to and is refused as a mismatch the
          // instant it is sent back.
          const boundHere = boundInputIds(parsedDocument.flow)
          let changed = false
          const next = { ...varsRef.current }
          for (const input of parsedDocument.flow.inputs) {
            if (!(input.id in next)) {
              next[input.id] = boundHere.has(input.id) ? (dry.vars[input.id] ?? '') : (input.default ?? '')
              changed = true
            }
          }
          if (changed) {
            // The token this response just minted is bound to the vars it was
            // asked with, not the defaults just filled in — showing it now
            // would let Start redeem a token for vars nobody typed and the
            // host never agreed to. Re-preview with the vars now in effect
            // instead; `previewPending` (still true, guarded by `sequence`
            // below) keeps Start disabled until a token bound to *these*
            // vars comes back.
            setVars(next)
            void runDryRun(text)
            return
          }
        } else {
          setStale(true)
        }
        if (!sentenceTouched.current) setSentence(dry.sentence)
        setPreview(dry)
        setPreviewGeneration(activeGeneration.current)
      } catch (error) {
        if (!activeOwner.current || mine !== sequence.current) return
        setStale(true)
        setProblem(error instanceof Error ? error.message : 'That shape could not be checked.')
      } finally {
        if (activeOwner.current && mine === sequence.current) setPreviewPending(false)
      }
    },
    [context, goal, page, store],
  )

  const initializeDraft = useCallback(async (): Promise<void> => {
    if (!activeOwner.current) return
    const mine = ++sequence.current
    try {
      const rendered = await store.renderShape(emptyShapePolicy())
      if (!activeOwner.current || mine !== sequence.current) return
      setLoadingDraft(false)
      if (rendered.issues.length === 0) {
        setSourceBoth(rendered.source)
        await runDryRun(rendered.source)
      } else setFormIssues(rendered.issues)
    } catch (error) {
      if (!activeOwner.current || mine !== sequence.current) return
      setLoadingDraft(false)
      setProblem(error instanceof Error ? error.message : 'A blank draft could not be read.')
    }
  }, [runDryRun, store])

  // The initial bytes are read once; a retained page resumes its own draft.
  useEffect(() => {
    activeOwner.current = !page || active
    if (document !== undefined || initialSource !== undefined) void runDryRun(sourceRef.current)
    else void initializeDraft()
    return () => { activeOwner.current = false; sequence.current++; saveReadSequence.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const editSource = (text: string): void => {
    if (!activeOwner.current) return
    pendingPolicy.current = null
    const previousSource = sourceRef.current
    if (page) setHistory(previous => [...previous, { kind: 'source', source: previousSource }])
    setSourceBoth(text)
    void runDryRun(text)
  }

  /**
   * A var deferred by `setVar` while a step or rule edit's own render was
   * out, given the dry run it never got — once no render is pending any
   * more, against the last known-good source. A no-op otherwise. Called only
   * from a path that will not itself call `runDryRun` — the clean success
   * path already does, reading `varsRef.current` fresh, and calling this
   * first there would bump the shared sequence out from under that call's
   * own `mine` check and lose it.
   */
  const flushDeferredVar = (): void => {
    if (!activeOwner.current || !varEditPending.current || renderPending()) return
    varEditPending.current = false
    void runDryRun(sourceRef.current)
  }

  const editPolicy = useCallback(
    async (next: FlowPolicy, recordHistory = true): Promise<void> => {
      if (!activeOwner.current) return
      const previousRenderPending = renderPending()
      pendingPolicy.current = next
      const previousPolicy = policyRef.current
      policyRef.current = next
      const previousSource = sourceRef.current
      // An unfinished ordered edit has no source yet. Every settled draft
      // does, including comments, formatting and text that does not parse.
      if (page && recordHistory) setHistory(previous => [...previous, previousRenderPending && previousPolicy ? { kind: 'policy', policy: previousPolicy } : { kind: 'source', source: previousSource }])
      // Retires a dry run already in flight (a var edit's, say) the instant a
      // step or rule changes, and — with `previewPending` below — keeps Start
      // disabled for the *whole* render round trip this edit takes, not just
      // once `runDryRun` itself starts: a click on Start while `renderShape`
      // is still out would otherwise redeem the dry run from before this edit.
      //
      // Two edits can be in flight together — a second step change fired
      // before the first's `renderShape` answered — and they need not land in
      // order: `mine` is this call's own claim on the sequence, checked again
      // after the await, so a stale answer (an earlier edit's, resolving
      // late) touches no state at all once a later edit has already taken
      // it, rather than re-enabling Start or racing it into `runDryRun` with
      // the wrong policy.
      const mine = ++sequence.current
      const myRender = ++renderIssued.current
      setPolicy(next)
      setFormIssues([])
      setPreviewPending(true)
      let rendered: { readonly source: string; readonly issues: readonly AuthoringIssue[] }
      try {
        rendered = await store.renderShape(next)
      } catch (error) {
        // Settled on every exit from here, including a `mine` that no longer
        // matches `sequence` — which used to return before either this or
        // `renderPending()`'s clearing ever ran, and left it true forever the
        // moment nothing with a *matching* sequence was ever going to settle
        // again (`editSource`'s own dry run, say, answering in between).
        renderSettled.current = Math.max(renderSettled.current, myRender)
        if (mine !== sequence.current) {
          flushDeferredVar()
          return
        }
        setFormIssues([{ at: 'file', text: error instanceof Error ? error.message : 'This change could not be checked.', fix: 'Try again.' }])
        setPreviewPending(false)
        flushDeferredVar()
        return
      }
      renderSettled.current = Math.max(renderSettled.current, myRender)
      if (mine !== sequence.current) {
        flushDeferredVar()
        return
      }
      if (rendered.issues.length > 0) {
        setFormIssues(rendered.issues)
        setPreviewPending(false)
        flushDeferredVar()
        return
      }
      varEditPending.current = false
      pendingPolicy.current = null
      setSourceBoth(rendered.source)
      void runDryRun(rendered.source)
    },
    [page, runDryRun, store],
  )

  const wasActive = useRef(active)
  useEffect(() => {
    const resumed = page && active && !wasActive.current
    wasActive.current = active
    if (!resumed) return
    if (pendingPolicy.current) void editPolicy(pendingPolicy.current, false)
    else if (loadingDraft && sourceRef.current === '') void initializeDraft()
    else void runDryRun(sourceRef.current)
  }, [active, page, loadingDraft, editPolicy, initializeDraft, runDryRun])

  // ------------------------------------------------------------------ steps

  const roleIds = new Set((policy?.roles ?? []).map((role) => role.id))

  const addRole = (kind: FlowPolicyRole['kind']): void => {
    if (!policy) return
    const id = uniqueId(kind, roleIds, kind)
    setSelectedRole(id)
    void editPolicy({ ...policy, roles: [...policy.roles, defaultRole(kind, id)] })
  }
  const updateRole = (index: number, next: FlowPolicyRole): void => {
    if (!policy) return
    const before = policy.roles[index]!
    const roles = policy.roles.map((role, one) => (one === index ? next : role))
    const withRoles = { ...policy, roles }
    void editPolicy(before.id !== next.id ? renameRoleReferences(withRoles, before.id, next.id) : withRoles)
  }
  const removeRole = (index: number): void => {
    if (!policy) return
    const role = policy.roles[index]!
    if (!roleRemovable(policy, role.id)) return
    void editPolicy({
      ...policy,
      ...(policy.complete === undefined ? {} : { complete: Object.fromEntries(Object.entries(policy.complete).filter(([id]) => id !== role.id)) }),
      roles: policy.roles.filter((_, one) => one !== index),
    })
  }
  const moveRole = (index: number, delta: number): void => {
    if (!policy) return
    const to = index + delta
    if (to < 0 || to >= policy.roles.length) return
    const roles = [...policy.roles]
    ;[roles[index], roles[to]] = [roles[to]!, roles[index]!]
    void editPolicy({ ...policy, roles })
  }

  // ------------------------------------------------------------------ rules

  const addRule = (): void => {
    if (!policy || policy.roles.length === 0) return
    const on = policy.roles[0]!.id
    const target = policy.roles[0]!.id
    const id = uniqueId(`${on}-rule`, new Set(policy.rules.map((rule) => rule.id)), 'rule')
    setSelectedRule(id)
    if (page) setRail(true)
    void editPolicy({ ...policy, rules: [...policy.rules, defaultRule(id, on, target)] })
  }
  const updateRule = (index: number, next: FlowPolicyRule): void => {
    if (!policy) return
    void editPolicy({ ...policy, rules: policy.rules.map((rule, one) => (one === index ? next : rule)) })
  }
  const removeRule = (index: number): void => {
    if (!policy) return
    void editPolicy({ ...policy, rules: policy.rules.filter((_, one) => one !== index) })
  }
  const moveRule = (index: number, delta: number): void => {
    if (!policy) return
    const to = index + delta
    if (to < 0 || to >= policy.rules.length) return
    const rules = [...policy.rules]
    ;[rules[index], rules[to]] = [rules[to]!, rules[index]!]
    void editPolicy({ ...policy, rules })
  }

  const setVar = (varId: string, value: string): void => {
    if (!activeOwner.current) return
    const next = { ...varsRef.current, [varId]: value }
    setVars(next)
    if (renderPending()) {
      // A step or rule edit's own render is still out, so `source` here is
      // the shape from before it — a dry run against it would preview, and
      // once that edit's own answer lands stale, permanently show, the edit
      // undone. That edit's own dry run already reads `varsRef.current`
      // fresh when it fires; this only waits for it, flushing itself if the
      // edit fails or is refused instead.
      varEditPending.current = true
      return
    }
    void runDryRun(source)
  }

  const flow = preview?.flow ?? null
  const compiled = flow?.compiled.document ?? null
  const errors = (flow?.problems ?? []).filter((one) => one.level === 'error')
  const warnings = (flow?.problems ?? []).filter((one) => one.level === 'warning')
  const previewCurrent = !page || (active && previewGeneration === activeGeneration.current)
  const startable = previewCurrent && !stale && formIssues.length === 0 && flow !== null && flow.token !== null && compiled?.format === 'agents' && errors.length === 0
  const sentenceValid = sentence.trim().length > 0 && sentence.trim().length <= 2000

  const start = async (): Promise<void> => {
    if (!preview?.flow.token || !startable || !sentenceValid || starting || previewPending) return
    setStarting(true)
    setStartProblem(null)
    try {
      const execution = await store.startFlowGoal({
        root,
        source,
        token: preview.flow.token,
        sentence: sentence.trim(),
        // Exactly what the redeemed token's own preview echoed back — never
        // the vars ref, which can differ from it for the span between a
        // default filling in and the re-preview it triggers landing.
        vars: preview.vars,
        ...(preview.goal ? { goal: preview.goal } : {}),
      })
      onStarted(execution)
    } catch (error) {
      setStarting(false)
      setStartProblem(error instanceof Error ? error.message : 'The desk did not start this.')
    }
  }

  const inputs = compiled?.format === 'agents' ? compiled.flow.inputs : []
  /** Which of `inputs` this shape's own layout fills from the resolved start target — head, base, a pull request — rather than from a person typing. */
  const bound = compiled?.format === 'agents' ? boundInputValues(compiled.flow) : new Map<string, never>()

  const saveOverlay = (!page || active) && showSave && policy && (
        <ShapeSave
          input={{
            target: !duplicate && document?.target.kind === 'flow'
              ? { kind: 'flow', origin: document.target.origin === 'builtin' ? 'user' : document.target.origin, id: document.target.id, root }
              : { kind: 'flow', origin: 'project', id: uniqueId(duplicate ? `${policy.name}-copy` : policy.name, new Set(), 'shape'), root },
            expected: !duplicate && document?.target.kind === 'flow' && document.target.origin !== 'builtin' && document.exists ? document.digest : null,
            source,
          }}
          onSaved={(result, target) => {
            setDuplicate(false)
            if (target.kind === 'flow') {
              setSavedFlowId(target.id)
              const mine = ++saveReadSequence.current
              const appliedSource = source
              setDocument(undefined)
              setSaveReadPending(true)
              setSaveConflict(null)
              void store.readAuthoring(target).then(fresh => {
                if (mine !== saveReadSequence.current) return
                setSaveReadPending(false)
                if (fresh.source !== appliedSource) {
                  setSaveConflict({ document: fresh, message: 'The saved file changed before it could be read. Review its current contents before overwriting or deleting it.' })
                  return
                }
                setDocument(fresh)
              }, () => {
                if (mine !== saveReadSequence.current) return
                setSaveReadPending(false)
                setSaveConflict({ document: null, message: 'The saved file could not be read. Reopen this Flow before overwriting or deleting it.' })
              })
            }
            setShowSave(false)
            // Every time on an unsaved shape first saves it, then names the
            // saved flow id it opens — never a renderer-only draft.
            const written = result.written[0]
            const match = written ? /(?:^|\/)([a-z0-9][a-z0-9_-]*)\.ya?ml$/.exec(written) : null
            if (saveForTrigger && match) {
              setSavedFlowId(match[1]!)
              setEveryTime(true)
            }
            setSaveForTrigger(false)
          }}
          onClose={() => {
            setShowSave(false)
            setDuplicate(false)
            setSaveForTrigger(false)
          }}
        />
      )

  const saveNotice = saveConflict && <Banner tone="warning" title="The saved file needs review">
    {saveConflict.message}
    {saveConflict.document && <Button size="sm" variant="outline" onClick={() => {
      const fresh = saveConflict.document
      if (!fresh || !activeOwner.current) return
      setDocument(fresh)
      setSaveConflict(null)
      setTab('source')
      editSource(fresh.source)
    }}>Review saved file</Button>}
  </Banner>

  if (page) {
    const selected = policy?.roles.findIndex(role => role.id === selectedRole) ?? -1
    const selectedIndex = selected >= 0 ? selected : 0
    const role = policy?.roles[selectedIndex]
    const bindings = role ? (flow?.compiled.bindings ?? []).filter(binding => binding.role === role.id) : []
    const answers = [...new Set(bindings.flatMap(binding => binding.agent.answers))]
    const efforts = [...new Set(bindings.flatMap(binding => binding.seats.map(seat => seat.effort).filter((effort): effort is string => Boolean(effort))))]
    const runs = matchingFlowRuns(policy, snapshot.flowExecutions.values()).filter(run => snapshot.goals.get(run.goal)?.goal.root === root)
    const legacy = compiled?.format === 'legacy' && compiled.flow.roles.length > 0
    const canWrite = previewCurrent && policy !== null && !stale && !previewPending && formIssues.length === 0
    const connect = ({ source: from, target }: { readonly source: string; readonly target: string }): void => {
      if (!policy) return
      const id = uniqueId(`${from}-to-${target}`, new Set(policy.rules.map(rule => rule.id)), 'rule')
      setSelectedRule(id)
      setRail(true)
      void editPolicy({ ...policy, rules: [...policy.rules, defaultRule(id, from, target)] })
    }
    return <>
      <ShapePageBar title={policy?.name ?? 'New Flow'} rail={rail} onRail={() => setRail(value => !value)}
        onBack={onClose} onRename={() => { setName(policy?.name ?? ''); setRename(true) }}
        onDuplicate={() => { setDuplicate(true); setShowSave(true) }}
        onDelete={() => setDeleting(true)} canWrite={canWrite}
        deleteReason={saveReadPending ? 'The saved Flow is still being read.' : saveConflict ? 'Review the saved file before deleting it.' : !document || document.target.kind !== 'flow' ? 'Save this Flow first.' : document.target.origin === 'builtin' ? 'Built-in Flows cannot be deleted.' : !document.writable ? 'This Flow cannot be changed here.' : false} />
      <FlowCanvasWorkspace onCloseRail={() => setRail(false)} toolbar={
          <FlowCanvasToolbar actions={<>
            <Button size="sm" variant="outline" disabled={!policy || previewPending} onClick={() => { setShowDryRun(true); void runDryRun(sourceRef.current) }}>{previewPending ? 'Checking…' : 'Dry run'}</Button>
            <Button size="sm" disabled={!canWrite} onClick={() => onStartTeam?.(sourceRef.current)}>Start a Team</Button>
          </>}>
            <DropdownMenu icons="none">
              <DropdownMenuTrigger render={<Button size="sm" variant="outline" disabled={!policy}><PlusIcon size={14} />Step</Button>} />
              <DropdownMenuContent align="start">
                {(['agent', 'check', 'person'] as const).map(kind => <DropdownMenuItem key={kind} label={kind === 'agent' ? 'Agent' : kind === 'check' ? 'Check' : 'Person'} onClick={() => addRole(kind)} />)}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" variant="outline" disabled={!policy?.roles.length} onClick={addRule}><PlusIcon size={14} />Rule</Button>
            <Button size="sm" variant="ghost" disabled={history.length === 0 || previewPending} onClick={() => {
              const previous = history.at(-1)
              if (previous === undefined) return
              setHistory(current => current.slice(0, -1))
              if (previous.kind === 'policy') void editPolicy(previous.policy, false)
              else {
                pendingPolicy.current = null
                setSourceBoth(previous.source)
                void runDryRun(previous.source)
              }
            }}>Undo</Button>
            <Tabs value={tab} onValueChange={next => setTab(next as typeof tab)}>
              <TabsList aria-label="Flow view">
                <TabsTrigger value="graph">Graph</TabsTrigger><TabsTrigger value="steps">Steps</TabsTrigger><TabsTrigger value="source">File</TabsTrigger>
              </TabsList>
            </Tabs>
          </FlowCanvasToolbar>} main={<>
          {loadingDraft && <Note>Reading…</Note>}
          {stale && <Banner tone="warning" title={legacy && document ? 'This Flow uses an earlier format' : 'This source does not parse yet'}>{legacy && document && onUpdate ? <Button size="sm" variant="outline" onClick={onUpdate}>{document.target.origin === 'project' ? 'Update…' : 'Customize…'}</Button> : 'The steps below are the last valid form. Fix the file to save or start this Flow.'}</Banner>}
          {formIssues.length > 0 && <Banner tone="danger" title="This change cannot be saved or started yet"><NoteList>{formIssues.map(issue => <li key={`${issue.at}:${issue.text}`}>{issue.at} — {issue.text} {issue.fix}</li>)}</NoteList></Banner>}
          {problem && <ActionError>{problem}</ActionError>}
          {tab === 'graph' && policy && <FlowCanvasSurface><ShapeGraph policy={policy} selected={selectedRole} selectedRule={selectedRule} canvasOnly
            onSelect={id => { setSelectedRole(id); setSelectedRule(null); if (id) setRail(true) }} onConnect={connect}
            onAddStep={() => addRole('agent')}
            onRemoveRole={id => { const index = policy.roles.findIndex(role => role.id === id); if (index >= 0) removeRole(index) }}
            onRemoveRule={id => { const index = policy.rules.findIndex(rule => rule.id === id); if (index >= 0) removeRule(index) }}
            onPositions={positions => void editPolicy(withGraphPositions(policy, positions))}
            onEditRule={id => { setSelectedRole(null); setSelectedRule(id); setRail(true) }} /></FlowCanvasSurface>}
          {tab === 'steps' && policy && <FlowCanvasContent><Rows>{policy.roles.map((one, index) => <div key={one.id}>
            <Row title={`${index + 1}. ${one.id}`} control={<Button size="sm" variant="ghost" onClick={() => { setSelectedRole(one.id); setRail(true) }}>Select</Button>} />
            <ShapeStep role={one} agents={[...roster.values()]} runtimes={snapshot.runtimes} onChange={next => updateRole(index, next)} />
          </div>)}</Rows></FlowCanvasContent>}
          {tab === 'source' && <FlowCanvasContent><Field label="Source" hint="The exact file this would write. Unrecognized syntax stays here.">{control => <Textarea {...control} variant="code" rows={24} value={source} onChange={event => editSource(event.target.value)} />}</Field></FlowCanvasContent>}
          {errors.length > 0 && <Banner tone="danger" title="This will not run yet"><NoteList>{errors.map(error => <li key={`${error.at}:${error.text}`}>{error.at} — {error.text}</li>)}</NoteList></Banner>}
        </>} rail={rail ? <ToolBody>
          <ToolSection label={role ? `Step · ${role.id}` : 'Selected step'}>
            {role ? <><KeyValue variant="panel"><KeyValueRow label="Role">{role.id}</KeyValueRow>
              {role.kind === 'agent' && <><KeyValueRow label="Agent">{role.uses.map(id => roster.get(id)?.definition?.name ?? id).join(', ') || 'Choose an Agent'}</KeyValueRow><KeyValueRow label="Effort">{efforts.join(', ') || role.seats.map(seat => seat.effort).filter(Boolean).join(', ') || 'Agent preference'}</KeyValueRow><KeyValueRow label="Answers">{answers.join(', ') || 'Declared by the Agent'}</KeyValueRow><KeyValueRow label="When it pushes">{role.grant === 'read' || role.grant === 'edit' ? 'Cannot push' : 'Follows its grant'}</KeyValueRow></>}
              </KeyValue><ToolFold label="Edit step">
              <ShapeStep key={role.id} role={role} agents={[...roster.values()]} runtimes={snapshot.runtimes} onChange={next => { setSelectedRole(next.id); updateRole(selectedIndex, next) }} />
              <ToolBodyControls><Button size="sm" variant="ghost" disabled={selectedIndex === 0} onClick={() => moveRole(selectedIndex, -1)}>Move up</Button><Button size="sm" variant="ghost" disabled={!policy || selectedIndex === policy.roles.length - 1} onClick={() => moveRole(selectedIndex, 1)}>Move down</Button><Button size="sm" variant="ghost" disabled={!policy || !roleRemovable(policy, role.id)} onClick={() => removeRole(selectedIndex)}>Remove step</Button></ToolBodyControls></ToolFold></> : <ToolProse>Select a step to edit it.</ToolProse>}
          </ToolSection>
          <ToolSection key={`rules:${selectedRule ?? ''}`} label="Rules" value={policy?.rules.length ?? 0} fold defaultOpen={selectedRule !== null}>
            <ToolProse variant="note">Tried in order; the first match fires. A round that matches nothing ends the Run.</ToolProse>
            {policy?.rules.map((rule, index) => <div key={rule.id}><Row title={`${index + 1}. ${rule.id}`} control={
              <DropdownMenu icons="none"><DropdownMenuTrigger render={<BoardMenuButton aria-label={`Rule ${rule.id} actions`} />} /><DropdownMenuContent align="end">
                <DropdownMenuItem label="Move up" icon={<MoveUpIcon size={14} />} disabled={index === 0} onClick={() => moveRule(index, -1)} />
                <DropdownMenuItem label="Move down" icon={<MoveDownIcon size={14} />} disabled={index === policy.rules.length - 1} onClick={() => moveRule(index, 1)} />
                <DropdownMenuSeparator /><DropdownMenuItem label="Remove rule" variant="destructive" icon={<TrashIcon size={14} />} onClick={() => removeRule(index)} />
              </DropdownMenuContent></DropdownMenu>
            } /><ShapeRule rule={rule} policy={policy} onChange={next => updateRule(index, next)} /></div>)}
            {policy?.rules.length === 0 && <ToolProse>No rules yet. The seed round runs, then the Run ends.</ToolProse>}
          </ToolSection>
          <ToolSection label="Triggers" fold defaultOpen={false}>
            {savedFlowId ? <ProjectTriggers key={savedFlowId} root={root} flow={savedFlowId} embedded /> : <ToolProse>Save this Flow before adding a trigger.</ToolProse>}
            <TriggerSettings />
          </ToolSection>
          <ToolSection label="Runs" value={countKnown(root) ? runs.length : '—'} fold defaultOpen={false}>
            <ToolProse variant="note">{countKnown(root) ? 'Loaded Runs with this exact policy; identical copies match too.' : 'The recorded Runs could not all be read yet.'}</ToolProse>
            {runs.length === 0 ? <ToolProse>No recorded Runs loaded for this Flow.</ToolProse> : runs.map(run => <Row key={run.id} title={run.id} desc={run.state} control={<Button size="sm" variant="ghost" onClick={() => store.openGoal(run.goal)}>Open Team</Button>} />)}
          </ToolSection>
          <ToolSection label="Source" fold>
            <ToolProse>{saveReadPending ? 'Reading saved Flow…' : document?.displayPath ?? 'Unsaved Flow'}</ToolProse>
            {saveNotice}
            <ToolBodyControls><Button size="sm" variant="outline" disabled={!canWrite || saveReadPending || saveConflict !== null} onClick={() => setShowSave(true)}>Save…</Button><Button size="sm" variant="ghost" onClick={() => setTab('source')}>File</Button></ToolBodyControls>
            {document?.issues.map(issue => <ToolProse key={`${issue.at}:${issue.text}`}>{issue.text} {issue.fix}</ToolProse>)}
          </ToolSection>
        </ToolBody> : undefined} />
      {active && rename && policy && <Dialog title="Rename Flow" onClose={() => setRename(false)} footer={<><Button disabled={!name.trim()} onClick={() => { void editPolicy({ ...policy, name: name.trim() }); setRename(false) }}>Rename</Button><Button variant="secondary" onClick={() => setRename(false)}>Cancel</Button></>}><Field label="Name">{control => <Input {...control} value={name} onChange={event => setName(event.target.value)} />}</Field></Dialog>}
      {active && deleting && document?.target.kind === 'flow' && document.target.origin !== 'builtin' && <ConfirmDialog title="Delete Flow?" confirmLabel="Delete" tone="destructive" busy={starting} onCancel={() => setDeleting(false)} onConfirm={() => {
        if (document.target.kind !== 'flow' || document.target.origin === 'builtin' || starting) return
        setStarting(true); setStartProblem(null)
        void store.removeFlow(root, document.target.id, document.target.origin, document.digest).then(onClose, error => { setStarting(false); setStartProblem(error instanceof Error ? error.message : 'This Flow could not be deleted.') })
      }}><p>This moves {document.displayPath} to the Trash. Recorded Runs keep the Flow they started with.</p>{startProblem && <ActionError>{startProblem}</ActionError>}</ConfirmDialog>}
      {saveOverlay}
      {active && showDryRun && <Dialog title="Dry run" size="lg" onClose={() => setShowDryRun(false)} footer={<Button variant="default" onClick={() => setShowDryRun(false)}>Close</Button>}>
        {previewPending && <Note>Checking…</Note>}
        {flow && compiled?.format === 'agents' && <FlowPreviewReport preview={flow} flow={compiled.flow} warnings={warnings} roster={roster} vars={vars} />}
        {problem && <ActionError>{problem}</ActionError>}
      </Dialog>}
    </>
  }

  return (
    <Dialog
      title="Your own shape"
      size="lg"
      onClose={onClose}
      footer={(
        <>
          <Button variant="default" disabled={!startable || !sentenceValid || starting || previewPending} onClick={() => void start()}>
            {starting ? 'Starting…' : 'Start'}
          </Button>
          <Button variant="secondary" disabled={!policy || saveReadPending || saveConflict !== null} onClick={() => setShowSave(true)}>Save…</Button>
          {/* A dialog footer's own rule holds every control in it, and a
              `DropdownMenu`'s trigger is a `render` prop — not JSX the
              audit's footer reader can see into. This stands as an ordinary
              button instead of hiding behind an overflow menu. */}
          <Button
            variant="secondary"
            disabled={!policy}
            onClick={() => {
              if (savedFlowId) setEveryTime(true)
              else {
                setSaveForTrigger(true)
                setShowSave(true)
              }
            }}
          >
            Every time…
          </Button>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </>
      )}
    >
      {saveNotice}
      {loadingDraft && <Note>Reading…</Note>}

      {!loadingDraft && (
        <>
          <Tabs value={tab} onValueChange={(next) => setTab(next as 'steps' | 'graph' | 'source')}>
            <TabsList aria-label="Shape view">
              <TabsTrigger value="steps">Steps</TabsTrigger>
              <TabsTrigger value="graph">Graph</TabsTrigger>
              <TabsTrigger value="source">Source</TabsTrigger>
            </TabsList>
          </Tabs>

          {stale && (
            <Banner tone="warning" title="This source does not parse yet">
              The steps below are the last valid form. Fix the source, or switch back to editing steps.
            </Banner>
          )}

          {formIssues.length > 0 && (
            <Banner tone="danger" title="This change cannot be saved or started yet">
              <NoteList>
                {formIssues.map((one) => <li key={`${one.at}-${one.text}`}><code>{one.at}</code> — {one.text} {one.fix}</li>)}
              </NoteList>
            </Banner>
          )}

          {tab === 'steps' && policy && (
            <>
              <section aria-label="Steps">
                <div className="flex justify-end gap-(--hd-space-2)">
                  <Button size="sm" variant="outline" onClick={() => addRole('agent')}><PlusIcon size={14} />Agent</Button>
                  <Button size="sm" variant="outline" onClick={() => addRole('check')}><PlusIcon size={14} />Check</Button>
                  <Button size="sm" variant="outline" onClick={() => addRole('person')}><PlusIcon size={14} />Person</Button>
                </div>
                <Rows>
                  {policy.roles.map((role, index) => (
                    <div key={role.id}>
                      <Row
                        title={`${index + 1}. ${role.id}`}
                        desc={role.kind === 'agent' ? 'Agent' : role.kind === 'check' ? 'Check' : 'Person'}
                        control={(
                          <DropdownMenu icons="none">
                            <DropdownMenuTrigger disabled={!policy} render={<BoardMenuButton aria-label={`${role.id} actions`} />} />
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem disabled={index === 0} onClick={() => moveRole(index, -1)} label={"Move up"} icon={<MoveUpIcon size={14} />} />
                              <DropdownMenuItem disabled={index === policy.roles.length - 1} onClick={() => moveRole(index, 1)} label={"Move down"} icon={<MoveDownIcon size={14} />} />
                              <DropdownMenuSeparator />
                              <DropdownMenuItem variant="destructive" disabled={!roleRemovable(policy, role.id)} title={roleRemovable(policy, role.id) ? undefined : 'The seed step, and a step a rule still points at, cannot be removed.'} onClick={() => removeRole(index)} label={"Remove step"} icon={<TrashIcon size={14} />} />
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      />
                      <ShapeStep
                        role={role}
                        agents={[...roster.values()]}
                        runtimes={snapshot.runtimes}
                        onChange={(next) => updateRole(index, next)}
                      />
                    </div>
                  ))}
                </Rows>
              </section>

              <section aria-label="Rules">
                <SectionHead name="Rules" action={<Button size="sm" variant="outline" onClick={addRule}><PlusIcon size={14} />Add a rule</Button>} />
                <Note>Tried in order; the first match fires. A round that matches nothing ends the run.</Note>
                <Rows>
                  {policy.rules.length === 0 && <Row title="No rules yet — the seed round runs, then the run ends" />}
                  {policy.rules.map((rule, index) => (
                    <div key={rule.id}>
                      <Row
                        title={`${index + 1}. ${rule.id}`}
                        desc={`${rule.on} → ${rule.then.role}`}
                        control={(
                          <DropdownMenu icons="none">
                            <DropdownMenuTrigger render={<BoardMenuButton aria-label={`Rule ${rule.id} actions`} />} />
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem disabled={index === 0} onClick={() => moveRule(index, -1)} label={"Move up"} icon={<MoveUpIcon size={14} />} />
                              <DropdownMenuItem disabled={index === policy.rules.length - 1} onClick={() => moveRule(index, 1)} label={"Move down"} icon={<MoveDownIcon size={14} />} />
                              <DropdownMenuSeparator />
                              <DropdownMenuItem variant="destructive" onClick={() => removeRule(index)} label={"Remove rule"} icon={<TrashIcon size={14} />} />
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      />
                      <ShapeRule rule={rule} policy={policy} onChange={(next) => updateRule(index, next)} />
                    </div>
                  ))}
                </Rows>
              </section>
            </>
          )}

          {tab === 'graph' && policy && (
            <ShapeGraph
              policy={policy}
              selected={selectedRole}
              onSelect={setSelectedRole}
              onPositions={(positions) => void editPolicy(withGraphPositions(policy, positions))}
              onEditRule={(ruleId) => {
                setTab('steps')
                setSelectedRole(policy.rules.find((rule) => rule.id === ruleId)?.on ?? null)
              }}
            />
          )}

          {tab === 'source' && (
            <Field label="Source" hint="The exact file this would write. Unrecognized syntax stays here, never silently stripped.">
              {(control) => (
                <Textarea {...control} variant="code" rows={20} value={source} onChange={(event) => editSource(event.target.value)} />
              )}
            </Field>
          )}

          <Field label="What finishes this?" error={sentence.trim().length > 2000 ? 'Keep it to 2,000 characters.' : undefined}>
            {(control) => (
              <Input
                {...control}
                value={sentence}
                onChange={(event) => {
                  sentenceTouched.current = true
                  setSentence(event.target.value)
                }}
              />
            )}
          </Field>

          {problem && <ActionError>That shape could not be checked. {problem}</ActionError>}

          {inputs.filter((input) => !bound.has(input.id)).map((input) => (
            <Field key={input.id} label={input.label}>
              {(control) => <Input {...control} value={vars[input.id] ?? ''} onChange={(event) => setVar(input.id, event.target.value)} />}
            </Field>
          ))}

          {inputs.filter((input) => bound.has(input.id)).length > 0 && (
            <Rows>
              {inputs.filter((input) => bound.has(input.id)).map((input) => {
                // A fact the chosen start already filled in — never a field
                // that looks editable only to refuse the edit typing into it
                // would send.
                const value = vars[input.id] ?? ''
                const kind = bound.get(input.id)
                // `head`/`base` are commits — shown short, the full sha still
                // reachable on hover; a branch, a pull request or a diff's own
                // label is not a sha and is never shortened.
                const isSha = (kind === 'head' || kind === 'base') && value !== ''
                return (
                  <Row
                    key={input.id}
                    title={input.label}
                    desc={isSha ? <span title={value}>{shortSha(value)}</span> : (value || '—')}
                  />
                )
              })}
            </Rows>
          )}

          {errors.length > 0 && (
            <Banner tone="danger" title="This will not run yet">
              <NoteList>
                {errors.map((one) => <li key={`${one.at}-${one.text}`}><code>{one.at}</code> — {one.text}</li>)}
              </NoteList>
            </Banner>
          )}

          {flow && compiled?.format === 'agents' && (
            <FlowPreviewReport preview={flow} flow={compiled.flow} warnings={warnings} roster={roster} vars={vars} />
          )}

          {startProblem && <ActionError>{startProblem}</ActionError>}
        </>
      )}

      {saveOverlay}

      {everyTime && savedFlowId && (
        <TriggerCreate
          root={root}
          opens={{ flow: savedFlowId }}
          onClose={() => setEveryTime(false)}
          onSaved={() => setEveryTime(false)}
        />
      )}
    </Dialog>
  )
}

/** The page publishes subject actions into the shell's one bar. */
const ShapePageBar = ({ title, rail, onRail, onBack, onRename, onDuplicate, onDelete, canWrite, deleteReason }: {
  readonly title: string
  readonly rail: boolean
  readonly onRail: () => void
  readonly onBack: () => void
  readonly onRename: () => void
  readonly onDuplicate: () => void
  readonly onDelete: () => void
  readonly canWrite: boolean
  readonly deleteReason: string | false
}) => {
  const scope = useDestinationPage()
  useTopBar(scope.owner, {
    place: title,
    placeMenu: close => <>
      <MenuItem label="Rename" icon={<PencilIcon size={16} />} disabled={!canWrite && 'Wait for the current change to be checked.'} onSelect={() => { onRename(); close() }} />
      <MenuItem label="Duplicate" icon={<CopyIcon size={16} />} disabled={!canWrite && 'Wait for the current change to be checked.'} onSelect={() => { onDuplicate(); close() }} />
      <MenuItem label="Delete…" icon={<TrashIcon size={16} />} disabled={deleteReason} onSelect={() => { onDelete(); close() }} />
    </>,
    tools: <Button size="icon-sm" variant="ghost" aria-label="Flow details" aria-expanded={rail} title="Flow details" onClick={onRail}><PanelRightIcon size={16} /></Button>,
    more: close => <MenuItem label="All Flows" onSelect={() => { onBack(); close() }} />,
  }, scope.active)
  return null
}
