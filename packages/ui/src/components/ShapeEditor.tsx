import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  AgentEntry, AuthoringDocument, AuthoringIssue, FlowExecution, FlowPolicy, FlowPolicyRole, FlowPolicyRule, FrontDoorPreview, StartContext,
} from '@harnessdesk/protocol'

import {
  ActionError, Banner, BoardMenuButton, Button, Dialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  Field, Input, Note, NoteList, Row, Rows, SectionHead, Tabs, TabsList, TabsTrigger, Textarea,
} from '../design'
import { useSnapshot, useStore } from '../state/context'
import { boundInputIds, defaultRole, defaultRule, emptyShapePolicy, renameRoleReferences, roleRemovable, uniqueId, withGraphPositions } from '../lib/shapes'
import { PlusIcon, MoveDownIcon, MoveUpIcon, TrashIcon } from './Icons'
import { FlowPreviewReport } from './FlowStart'
import { ShapeGraph } from './ShapeGraph'
import { ShapeRule } from './ShapeRule'
import { ShapeSave } from './ShapeSave'
import { ShapeStep } from './ShapeStep'
import { TriggerCreate } from './TriggerCreate'

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
}

export const ShapeEditor = ({ root, context, goal, document, initialSource, onClose, onStarted }: ShapeEditorProps) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [tab, setTab] = useState<'steps' | 'graph' | 'source'>('steps')
  const [selectedRole, setSelectedRole] = useState<string | null>(null)
  const [source, setSource] = useState<string>(document?.source ?? initialSource ?? '')
  const [loadingDraft, setLoadingDraft] = useState(document === undefined && initialSource === undefined)
  const [policy, setPolicy] = useState<FlowPolicy | null>(null)
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
  const [saveForTrigger, setSaveForTrigger] = useState(false)
  const [savedFlowId, setSavedFlowId] = useState<string | null>(document?.target.kind === 'flow' ? document.target.id : null)
  const [everyTime, setEveryTime] = useState(false)
  const sequence = useRef(0)

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
      const mine = ++sequence.current
      setProblem(null)
      setPreviewPending(true)
      try {
        const dry = await store.previewFrontDoor({ context, source: text, vars: varsRef.current, ...(goal ? { goal } : {}) })
        if (mine !== sequence.current) return
        const parsedDocument = dry.flow.compiled.document
        if (parsedDocument.format === 'agents') {
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
      } catch (error) {
        if (mine !== sequence.current) return
        setStale(true)
        setProblem(error instanceof Error ? error.message : 'That shape could not be checked.')
      } finally {
        if (mine === sequence.current) setPreviewPending(false)
      }
    },
    [context, goal, store],
  )

  // Initial source: a chosen file's own bytes, an explicit starting text, or
  // a freshly rendered empty draft — never guessed here.
  useEffect(() => {
    let live = true
    if (document !== undefined || initialSource !== undefined) {
      void runDryRun(document?.source ?? initialSource ?? '')
      return
    }
    void (async () => {
      try {
        const rendered = await store.renderShape(emptyShapePolicy())
        if (!live) return
        setLoadingDraft(false)
        if (rendered.issues.length === 0) {
          setSource(rendered.source)
          await runDryRun(rendered.source)
        } else {
          setFormIssues(rendered.issues)
        }
      } catch (error) {
        if (!live) return
        setLoadingDraft(false)
        setProblem(error instanceof Error ? error.message : 'A blank draft could not be read.')
      }
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const editSource = (text: string): void => {
    setSource(text)
    void runDryRun(text)
  }

  const editPolicy = useCallback(
    async (next: FlowPolicy): Promise<void> => {
      // Retires a dry run already in flight (a var edit's, say) the instant a
      // step or rule changes, and — with `previewPending` below — keeps Start
      // disabled for the *whole* render round trip this edit takes, not just
      // once `runDryRun` itself starts: a click on Start while `renderShape`
      // is still out would otherwise redeem the dry run from before this edit.
      sequence.current += 1
      setPolicy(next)
      setFormIssues([])
      setPreviewPending(true)
      let rendered: { readonly source: string; readonly issues: readonly AuthoringIssue[] }
      try {
        rendered = await store.renderShape(next)
      } catch (error) {
        setFormIssues([{ at: 'file', text: error instanceof Error ? error.message : 'This change could not be checked.', fix: 'Try again.' }])
        setPreviewPending(false)
        return
      }
      if (rendered.issues.length > 0) {
        setFormIssues(rendered.issues)
        setPreviewPending(false)
        return
      }
      setSource(rendered.source)
      void runDryRun(rendered.source)
    },
    [runDryRun, store],
  )

  // ------------------------------------------------------------------ steps

  const roleIds = new Set((policy?.roles ?? []).map((role) => role.id))

  const addRole = (kind: FlowPolicyRole['kind']): void => {
    if (!policy) return
    const id = uniqueId(kind, roleIds, kind)
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
    void editPolicy({ ...policy, roles: policy.roles.filter((_, one) => one !== index) })
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
    const next = { ...varsRef.current, [varId]: value }
    setVars(next)
    void runDryRun(source)
  }

  const flow = preview?.flow ?? null
  const compiled = flow?.compiled.document ?? null
  const errors = (flow?.problems ?? []).filter((one) => one.level === 'error')
  const warnings = (flow?.problems ?? []).filter((one) => one.level === 'warning')
  const startable = !stale && formIssues.length === 0 && flow !== null && flow.token !== null && compiled?.format === 'agents' && errors.length === 0
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
  const bound = compiled?.format === 'agents' ? boundInputIds(compiled.flow) : new Set<string>()

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
          <Button variant="secondary" disabled={!policy} onClick={() => setShowSave(true)}>Save…</Button>
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
                          <DropdownMenu>
                            <DropdownMenuTrigger disabled={!policy} render={<BoardMenuButton aria-label={`${role.id} actions`} />} />
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem disabled={index === 0} onClick={() => moveRole(index, -1)}>
                                <MoveUpIcon size={14} />
                                Move up
                              </DropdownMenuItem>
                              <DropdownMenuItem disabled={index === policy.roles.length - 1} onClick={() => moveRole(index, 1)}>
                                <MoveDownIcon size={14} />
                                Move down
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                disabled={!roleRemovable(policy, role.id)}
                                title={roleRemovable(policy, role.id) ? undefined : 'The seed step, and a step a rule still points at, cannot be removed.'}
                                onClick={() => removeRole(index)}
                              >
                                <TrashIcon size={14} />
                                Remove step
                              </DropdownMenuItem>
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
                          <DropdownMenu>
                            <DropdownMenuTrigger render={<BoardMenuButton aria-label={`Rule ${rule.id} actions`} />} />
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem disabled={index === 0} onClick={() => moveRule(index, -1)}>
                                <MoveUpIcon size={14} />
                                Move up
                              </DropdownMenuItem>
                              <DropdownMenuItem disabled={index === policy.rules.length - 1} onClick={() => moveRule(index, 1)}>
                                <MoveDownIcon size={14} />
                                Move down
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem variant="destructive" onClick={() => removeRule(index)}>
                                <TrashIcon size={14} />
                                Remove rule
                              </DropdownMenuItem>
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
              {inputs.filter((input) => bound.has(input.id)).map((input) => (
                // A fact the chosen start already filled in — never a field
                // that looks editable only to refuse the edit typing into it
                // would send.
                <Row key={input.id} title={input.label} desc={vars[input.id] || '—'} />
              ))}
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
            <FlowPreviewReport preview={flow} flow={compiled.flow} warnings={warnings} roster={roster} />
          )}

          {startProblem && <ActionError>{startProblem}</ActionError>}
        </>
      )}

      {showSave && policy && (
        <ShapeSave
          input={{
            target: document?.target.kind === 'flow'
              ? { kind: 'flow', origin: document.target.origin === 'builtin' ? 'user' : document.target.origin, id: document.target.id, root }
              : { kind: 'flow', origin: 'project', id: uniqueId(policy.name, new Set(), 'shape'), root },
            expected: document?.target.kind === 'flow' && document.exists ? document.digest : null,
            source,
          }}
          onSaved={(result) => {
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
            setSaveForTrigger(false)
          }}
        />
      )}

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
