import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  AgentEntry, AuthoringDocument, AuthoringIssue, FlowExecution, FlowPolicy, FlowPolicyRole, FlowPolicyRule, FrontDoorPreview, StartContext,
} from '@harnessdesk/protocol'

import {
  ActionError, Banner, Button, Dialog, Field, Input, Note, NoteList, Row, Rows, SectionHead, Tabs, TabsList, TabsTrigger, Textarea,
} from '../design'
import { useStore } from '../state/context'
import { defaultRole, defaultRule, emptyShapePolicy, renameRoleReferences, roleRemovable, uniqueId } from '../lib/shapes'
import { PlusIcon, MoveDownIcon, MoveUpIcon } from './Icons'
import { FlowPreviewReport } from './FlowStart'
import { ShapeRule } from './ShapeRule'
import { ShapeSave } from './ShapeSave'
import { ShapeStep } from './ShapeStep'

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
  readonly document?: AuthoringDocument
  readonly initialSource?: string
  readonly onClose: () => void
  readonly onStarted: (execution: FlowExecution) => void
}

export const ShapeEditor = ({ root, context, document, initialSource, onClose, onStarted }: ShapeEditorProps) => {
  const store = useStore()
  const [tab, setTab] = useState<'steps' | 'source'>('steps')
  const [source, setSource] = useState<string>(document?.source ?? initialSource ?? '')
  const [loadingDraft, setLoadingDraft] = useState(document === undefined && initialSource === undefined)
  const [policy, setPolicy] = useState<FlowPolicy | null>(null)
  const [stale, setStale] = useState(false)
  const [formIssues, setFormIssues] = useState<readonly AuthoringIssue[]>([])
  const [roster, setRoster] = useState<ReadonlyMap<string, AgentEntry>>(new Map())
  const [vars, setVars] = useState<Readonly<Record<string, string>>>({})
  const [sentence, setSentence] = useState('')
  const sentenceTouched = useRef(false)
  const [preview, setPreview] = useState<FrontDoorPreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startProblem, setStartProblem] = useState<string | null>(null)
  const [showSave, setShowSave] = useState(false)
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
      try {
        const dry = await store.previewFrontDoor({ context, source: text, vars: {} })
        if (mine !== sequence.current) return
        const parsedDocument = dry.flow.compiled.document
        if (parsedDocument.format === 'agents') {
          setPolicy(parsedDocument.flow)
          setStale(false)
          const defaults = Object.fromEntries(parsedDocument.flow.inputs.map((input) => [input.id, input.default ?? '']))
          setVars(defaults)
        } else {
          setStale(true)
        }
        if (!sentenceTouched.current) setSentence(dry.sentence)
        setPreview(dry)
      } catch (error) {
        if (mine !== sequence.current) return
        setStale(true)
        setProblem(error instanceof Error ? error.message : 'That shape could not be checked.')
      }
    },
    [context, store],
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
      setPolicy(next)
      setFormIssues([])
      let rendered: { readonly source: string; readonly issues: readonly AuthoringIssue[] }
      try {
        rendered = await store.renderShape(next)
      } catch (error) {
        setFormIssues([{ at: 'file', text: error instanceof Error ? error.message : 'This change could not be checked.', fix: 'Try again.' }])
        return
      }
      if (rendered.issues.length > 0) {
        setFormIssues(rendered.issues)
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
    const next = { ...vars, [varId]: value }
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
    if (!preview?.flow.token || !startable || !sentenceValid || starting) return
    setStarting(true)
    setStartProblem(null)
    try {
      const execution = await store.startFlowGoal({
        root, source, token: preview.flow.token, sentence: sentence.trim(), vars: preview.vars,
      })
      onStarted(execution)
    } catch (error) {
      setStarting(false)
      setStartProblem(error instanceof Error ? error.message : 'The desk did not start this.')
    }
  }

  const inputs = compiled?.format === 'agents' ? compiled.flow.inputs : []

  return (
    <Dialog
      title="Your own shape"
      size="lg"
      onClose={onClose}
      footer={(
        <>
          <Button variant="default" disabled={!startable || !sentenceValid || starting} onClick={() => void start()}>
            {starting ? 'Starting…' : 'Start'}
          </Button>
          <Button variant="secondary" disabled={!policy} onClick={() => setShowSave(true)}>Save…</Button>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </>
      )}
    >
      {loadingDraft && <Note>Reading…</Note>}

      {!loadingDraft && (
        <>
          <Tabs value={tab} onValueChange={(next) => setTab(next as 'steps' | 'source')}>
            <TabsList aria-label="Shape view">
              <TabsTrigger value="steps">Steps</TabsTrigger>
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
                <SectionHead
                  name="Steps"
                  action={(
                    <span className="flex gap-(--hd-space-2)">
                      <Button size="sm" variant="outline" onClick={() => addRole('agent')}><PlusIcon size={14} />Agent</Button>
                      <Button size="sm" variant="outline" onClick={() => addRole('check')}><PlusIcon size={14} />Check</Button>
                      <Button size="sm" variant="outline" onClick={() => addRole('person')}><PlusIcon size={14} />Person</Button>
                    </span>
                  )}
                />
                <Rows>
                  {policy.roles.map((role, index) => (
                    <div key={role.id}>
                      <Row
                        title={`${index + 1}. ${role.id}`}
                        desc={role.kind === 'agent' ? 'Agent' : role.kind === 'check' ? 'Check' : 'Person'}
                        control={(
                          <span className="flex gap-1">
                            <Button size="sm" variant="outline" disabled={index === 0} aria-label={`Move ${role.id} up`} onClick={() => moveRole(index, -1)}><MoveUpIcon size={14} /></Button>
                            <Button size="sm" variant="outline" disabled={index === policy.roles.length - 1} aria-label={`Move ${role.id} down`} onClick={() => moveRole(index, 1)}><MoveDownIcon size={14} /></Button>
                          </span>
                        )}
                      />
                      <ShapeStep
                        role={role}
                        agents={[...roster.values()]}
                        onChange={(next) => updateRole(index, next)}
                        onRemove={() => removeRole(index)}
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
                          <span className="flex gap-1">
                            <Button size="sm" variant="outline" disabled={index === 0} aria-label={`Move rule ${rule.id} up`} onClick={() => moveRule(index, -1)}><MoveUpIcon size={14} /></Button>
                            <Button size="sm" variant="outline" disabled={index === policy.rules.length - 1} aria-label={`Move rule ${rule.id} down`} onClick={() => moveRule(index, 1)}><MoveDownIcon size={14} /></Button>
                          </span>
                        )}
                      />
                      <ShapeRule rule={rule} policy={policy} onChange={(next) => updateRule(index, next)} onRemove={() => removeRule(index)} />
                    </div>
                  ))}
                </Rows>
              </section>
            </>
          )}

          {tab === 'source' && (
            <Field label="Source" hint="The exact file this would write. Unrecognized syntax stays here, never silently stripped.">
              {(control) => (
                <Textarea {...control} className="font-mono text-xs" rows={20} value={source} onChange={(event) => editSource(event.target.value)} />
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

          {inputs.map((input) => (
            <Field key={input.id} label={input.label}>
              {(control) => <Input {...control} value={vars[input.id] ?? ''} onChange={(event) => setVar(input.id, event.target.value)} />}
            </Field>
          ))}

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
          onSaved={() => setShowSave(false)}
          onClose={() => setShowSave(false)}
        />
      )}
    </Dialog>
  )
}
