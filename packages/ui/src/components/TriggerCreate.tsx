import { useCallback, useEffect, useRef, useState } from 'react'

import {
  AGAIN_TITLE, TRIGGER_COMMENT_FROM,
  type AuthoringDocument, type AuthoringIssue, type AuthoringSavePreview, type TriggerBudget, type TriggerCommentFrom,
  type TriggerDefinition, type TriggerField, type TriggerSource,
} from '@harnessdesk/protocol'

import {
  ActionError, Banner, Button, CodeText, Dialog, Field, FormStack, Input, NativeSelect, Note, NoteList, Row, RowChoice, Rows, SectionHead, Switch,
} from '../design'
import { triggerBudgetWords, triggerCommentWords, triggerGroupingWords, triggerSentence } from '../lib/intake'
import { wholeTextDiff } from '../lib/diff'
import { useStore } from '../state/context'
import { DiffView } from './Diff'

/**
 * Every time: turn a shape or an Agent into a disarmed trigger, saved to the
 * working tree alone. Save is never consent — the existing TriggerArm preview
 * and its explicit Arm act, reached only after this file is committed, are
 * the one thing that authorizes unattended work. Nothing here stages,
 * commits or arms.
 */
export interface TriggerCreateProps {
  readonly root: string
  readonly opens: TriggerDefinition['opens']
  readonly onSaved: (id: string) => void
  readonly onClose: () => void
}

const SOURCE_WORDS: Readonly<Record<TriggerSource, string>> = {
  'pull-request': 'A pull request', issue: 'An issue', schedule: 'On a schedule',
}
const SOURCE_FIELDS: Readonly<Record<TriggerSource, readonly TriggerField[]>> = {
  'pull-request': ['pr', 'head', 'event'], issue: ['issue', 'event'], schedule: ['slot'],
}
const SOURCE_SUBJECT: Readonly<Record<TriggerSource, TriggerField>> = { 'pull-request': 'pr', issue: 'issue', schedule: 'slot' }
const FIELD_WORDS: Readonly<Record<TriggerField, string>> = {
  pr: 'pull request', head: 'head commit', event: 'event', issue: 'issue', slot: 'scheduled time',
}
/** The whole minutes a schedule may name — the same bound the parser holds it to. */
const SCHEDULE_MINUTES_MAX = 10080

const slugify = (text: string): string => {
  const slug = text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return slug || 'trigger'
}

export const TriggerCreate = ({ root, opens, onSaved, onClose }: TriggerCreateProps) => {
  const store = useStore()
  const [existing, setExisting] = useState<AuthoringDocument | null>(null)
  const [readProblem, setReadProblem] = useState<string | null>(null)
  const [id, setId] = useState(slugify('flow' in opens ? opens.flow : opens.agent))
  const [source, setSource] = useState<TriggerSource>('pull-request')
  const [definition, setDefinition] = useState<TriggerDefinition | null>(null)
  const [rendered, setRendered] = useState<{ readonly source: string } | null>(null)
  const [fieldIssues, setFieldIssues] = useState<readonly AuthoringIssue[]>([])
  const [preview, setPreview] = useState<AuthoringSavePreview | null>(null)
  const [previewProblem, setPreviewProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const sequence = useRef(0)

  useEffect(() => {
    let live = true
    store.readAuthoring({ kind: 'triggers', origin: 'project', root }).then(
      (doc) => { if (live) setExisting(doc) },
      (error: unknown) => { if (live) setReadProblem(error instanceof Error ? error.message : String(error)) },
    )
    return () => { live = false }
  }, [root, store])

  const renderOne = useCallback(async (next: TriggerDefinition): Promise<void> => {
    setDefinition(next)
    const mine = ++sequence.current
    try {
      const result = await store.renderTriggers([next])
      if (mine !== sequence.current) return
      if (result.issues.length > 0) {
        setFieldIssues(result.issues)
        setRendered(null)
      } else {
        setFieldIssues([])
        setRendered({ source: result.source })
      }
    } catch (error) {
      if (mine !== sequence.current) return
      setFieldIssues([{ at: 'file', text: error instanceof Error ? error.message : 'This trigger could not be checked.', fix: 'Try again.' }])
      setRendered(null)
    }
  }, [store])

  const draft = useCallback(async (nextId: string, nextSource: TriggerSource): Promise<void> => {
    const mine = ++sequence.current
    try {
      const next = await store.draftTrigger({ id: nextId, on: nextSource, opens })
      if (mine !== sequence.current) return
      // A fresh draft is rendered immediately, the same as any other field
      // edit — so the very first draft is already previewable, not only one
      // a person has since touched.
      await renderOne(next)
    } catch (error) {
      if (mine !== sequence.current) return
      setFieldIssues([{ at: 'file', text: error instanceof Error ? error.message : 'This draft could not be read.', fix: 'Choose a different id.' }])
    }
  }, [opens, renderOne, store])

  useEffect(() => {
    void draft(id, source)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const chooseSource = (next: TriggerSource): void => {
    setSource(next)
    void draft(id, next)
  }
  const changeId = (next: string): void => {
    setId(next)
    void draft(next, source)
  }

  const edit = (patch: Partial<TriggerDefinition>): void => {
    if (!definition) return
    void renderOne({ ...definition, ...patch } as TriggerDefinition)
  }
  const editField = (key: 'goal' | 'dedupe', field: TriggerField, checked: boolean): void => {
    if (!definition) return
    const current = definition[key]
    edit({ [key]: checked ? [...current, field].filter((one, index, all) => all.indexOf(one) === index) : current.filter((one) => one !== field) })
  }

  const previewSave = useCallback(async (): Promise<void> => {
    if (!rendered || !existing) return
    setPreviewProblem(null)
    const base = existing.exists && existing.source.trim() ? existing.source.replace(/\n*$/, '\n') : ''
    const combined = `${base}${rendered.source}`
    try {
      const next = await store.previewAuthoringSave({
        target: { kind: 'triggers', origin: 'project', root },
        expected: existing.exists ? existing.digest : null,
        source: combined,
      })
      setPreview(next)
    } catch (error) {
      setPreviewProblem(error instanceof Error ? error.message : String(error))
    }
  }, [existing, rendered, root, store])

  useEffect(() => {
    setPreview(null)
    if (rendered) void previewSave()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendered, existing])

  const save = async (): Promise<void> => {
    if (!preview?.token || busy) return
    setBusy(true)
    try {
      const result = await store.applyAuthoringSave(preview.token)
      if (result.state === 'applied' && definition) {
        setSaved(definition.id)
        onSaved(definition.id)
        return
      }
      setPreviewProblem(result.message)
    } catch (error) {
      setPreviewProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const fields = SOURCE_FIELDS[source]
  const subject = SOURCE_SUBJECT[source]
  const budget: TriggerBudget = definition?.budget ?? { usd: 5, rounds: 3, hours: 4, withoutProgress: 2 }
  const canSave = !saved && preview !== null && preview.token !== null && preview.issues.length === 0 && !busy

  if (readProblem) return <Banner tone="danger" title="This project's triggers could not be read">{readProblem}</Banner>
  if (existing && existing.issues.length > 0) {
    return (
      <Dialog title="Every time" onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
        <Banner tone="danger" title="This project's triggers file cannot take an addition yet">
          <NoteList>
            {existing.issues.map((one) => <li key={`${one.at}-${one.text}`}><code>{one.at}</code> — {one.text} {one.fix}</li>)}
          </NoteList>
        </Banner>
        <Note>Fix the existing file first — an addition never replaces an unrelated declaration it cannot read.</Note>
      </Dialog>
    )
  }

  return (
    <Dialog
      title="Every time"
      size="lg"
      onClose={onClose}
      footer={saved ? (
        <Button variant="secondary" onClick={onClose}>Close</Button>
      ) : (
        <>
          <Button variant="default" disabled={!canSave} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        </>
      )}
    >
      {saved ? (
        <Note>Saved. Commit this file before arming — open Triggers to review and Arm it.</Note>
      ) : (
        <>
          <Rows role="radiogroup" aria-label="Source">
            {(['pull-request', 'issue', 'schedule'] as const).map((one) => (
              <RowChoice key={one} title={SOURCE_WORDS[one]} selected={source === one} onClick={() => chooseSource(one)} />
            ))}
          </Rows>

          <Field label="Trigger name" hint="Shown wherever this trigger is listed.">
            {(control) => <Input {...control} value={id} onChange={(event) => changeId(event.target.value)} />}
          </Field>

          {definition && (
            <>
              {source === 'schedule' && definition.on.kind === 'schedule' && (
                <Field label="Every (minutes)" hint="Disarmed until you commit this file and arm it explicitly.">
                  {(control) => (
                    <Input
                      {...control}
                      type="number"
                      min={1}
                      max={SCHEDULE_MINUTES_MAX}
                      value={definition.on.kind === 'schedule' ? definition.on.everyMinutes : 60}
                      onChange={(event) => edit({ on: { kind: 'schedule', events: ['tick'], everyMinutes: Number(event.target.value) || 1 } })}
                    />
                  )}
                </Field>
              )}

              {source === 'pull-request' && definition.on.kind === 'pull-request' && (
                <section aria-label="Events">
                  <SectionHead name="Events" />
                  <Rows>
                    {(['opened', 'pushed'] as const).map((event) => (
                      <Row
                        key={event}
                        title={event}
                        control={(
                          <Switch
                            checked={definition.on.kind === 'pull-request' && definition.on.events.includes(event)}
                            aria-label={`Fire when a pull request is ${event}`}
                            onCheckedChange={(checked) => {
                              const events = definition.on.kind === 'pull-request' ? definition.on.events : []
                              edit({ on: { kind: 'pull-request', events: checked ? [...events, event] : events.filter((one) => one !== event) } })
                            }}
                          />
                        )}
                      />
                    ))}
                  </Rows>
                  <Field label="Forks">
                    {(control) => (
                      <NativeSelect {...control} value={definition.forks} onChange={(event) => edit({ forks: event.target.value as 'never' | 'allow' })}>
                        <option value="never">Never</option>
                        <option value="allow">Allow — read-only, no command runs against a fork</option>
                      </NativeSelect>
                    )}
                  </Field>
                </section>
              )}

              {source === 'issue' && definition.on.kind === 'issue' && (
                <section aria-label="Events">
                  <SectionHead name="Events" />
                  <Rows>
                    {(['labelled', 'closed', 'commented'] as const).map((event) => (
                      <Row
                        key={event}
                        title={event}
                        control={(
                          <Switch
                            checked={definition.on.kind === 'issue' && definition.on.events.includes(event)}
                            aria-label={`Fire when an issue is ${event}`}
                            onCheckedChange={(checked) => {
                              const events = definition.on.kind === 'issue' ? definition.on.events : []
                              const next = checked ? [...events, event] : events.filter((one) => one !== event)
                              edit({ on: { kind: 'issue', events: next }, ...(event === 'labelled' && !checked ? { label: undefined } : {}), ...(event === 'commented' && !checked ? { from: undefined } : {}) })
                            }}
                          />
                        )}
                      />
                    ))}
                  </Rows>
                  {definition.on.kind === 'issue' && definition.on.events.length === 1 && definition.on.events[0] === 'labelled' && (
                    <Field label="Labels" hint="One per line. Fires only when a labelled issue carries one of these.">
                      {(control) => (
                        <Input
                          {...control}
                          value={(definition.label ?? []).join(', ')}
                          onChange={(event) => edit({ label: event.target.value.split(',').map((one) => one.trim()).filter(Boolean) })}
                        />
                      )}
                    </Field>
                  )}
                  {definition.on.kind === 'issue' && definition.on.events.includes('commented') && (
                    <Field label="Comments that fire it">
                      {(control) => (
                        <NativeSelect {...control} value={definition.from ?? 'me'} onChange={(event) => edit({ from: event.target.value as TriggerCommentFrom })}>
                          {TRIGGER_COMMENT_FROM.map((one) => <option key={one} value={one}>{triggerCommentWords(one)}</option>)}
                        </NativeSelect>
                      )}
                    </Field>
                  )}
                </section>
              )}

              <section aria-label="Grouping">
                <SectionHead name="Goals" />
                <Note>{triggerGroupingWords(definition.goal)}</Note>
                <Rows>
                  {fields.map((field) => (
                    <Row
                      key={field}
                      title={FIELD_WORDS[field]}
                      control={(
                        <Switch
                          checked={definition.goal.includes(field)}
                          disabled={field === subject}
                          aria-label={`Group Goals by ${FIELD_WORDS[field]}`}
                          onCheckedChange={(checked) => editField('goal', field, checked)}
                        />
                      )}
                    />
                  ))}
                </Rows>
                <SectionHead name="What makes a firing new" />
                <Rows>
                  {fields.map((field) => (
                    <Row
                      key={field}
                      title={FIELD_WORDS[field]}
                      control={(
                        <Switch
                          checked={definition.dedupe.includes(field)}
                          aria-label={`Dedupe by ${FIELD_WORDS[field]}`}
                          onCheckedChange={(checked) => editField('dedupe', field, checked)}
                        />
                      )}
                    />
                  ))}
                </Rows>
              </section>

              {source !== 'schedule' && (
                <Row
                  title="Continue an open Goal"
                  desc={definition.again ? 'Stops the old round and opens a new one on the role named below.' : 'Records the fact and needs a person — no new round opens on its own.'}
                  wrapDesc
                  control={(
                    <Switch
                      checked={definition.again !== null}
                      aria-label="Continue an open Goal on a later firing"
                      onCheckedChange={(checked) => edit({ again: checked ? { role: 'writer', title: AGAIN_TITLE } : null })}
                    />
                  )}
                />
              )}
              {definition.again && (
                <Field label="Role a later firing opens">
                  {(control) => <Input {...control} value={definition.again!.role} onChange={(event) => edit({ again: { role: event.target.value, title: AGAIN_TITLE } })} />}
                </Field>
              )}

              <Field label="Concurrency">
                {(control) => (
                  <Input {...control} type="number" min={1} max={32} value={definition.concurrency} onChange={(event) => edit({ concurrency: Number(event.target.value) || 1 })} />
                )}
              </Field>

              <section aria-label="Budget">
                <SectionHead name="Budget" />
                <Note>{triggerBudgetWords(budget)}</Note>
                <FormStack>
                  <Field label="USD">
                    {(control) => <Input {...control} type="number" min={0.01} step={0.01} value={budget.usd} onChange={(event) => edit({ budget: { ...budget, usd: Number(event.target.value) || budget.usd } })} />}
                  </Field>
                  <Field label="Rounds">
                    {(control) => <Input {...control} type="number" min={1} value={budget.rounds} onChange={(event) => edit({ budget: { ...budget, rounds: Number(event.target.value) || budget.rounds } })} />}
                  </Field>
                  <Field label="Hours">
                    {(control) => <Input {...control} type="number" min={0.01} step={0.01} value={budget.hours} onChange={(event) => edit({ budget: { ...budget, hours: Number(event.target.value) || budget.hours } })} />}
                  </Field>
                  <Field label="Rounds without progress">
                    {(control) => <Input {...control} type="number" min={1} value={budget.withoutProgress} onChange={(event) => edit({ budget: { ...budget, withoutProgress: Number(event.target.value) || budget.withoutProgress } })} />}
                  </Field>
                </FormStack>
                <Note tone="warn">Stops when reported spend reaches the limit. Work already running can cost more before it stops.</Note>
              </section>

              <Note>{triggerSentence(definition)}</Note>
            </>
          )}

          {fieldIssues.length > 0 && (
            <Banner tone="danger" title="This trigger cannot be saved yet">
              <NoteList>
                {fieldIssues.map((one) => <li key={`${one.at}-${one.text}`}><code>{one.at}</code> — {one.text} {one.fix}</li>)}
              </NoteList>
            </Banner>
          )}

          {previewProblem && <ActionError>{previewProblem}</ActionError>}

          {preview && preview.issues.length > 0 && (
            <Banner tone="danger" title="This cannot be saved yet">
              <NoteList>
                {preview.issues.map((one) => <li key={`${one.at}-${one.text}`}><code>{one.at}</code> — {one.text} {one.fix}</li>)}
              </NoteList>
            </Banner>
          )}

          {preview && preview.edits.map((edit2) => (
            <div key={edit2.path} className="flex flex-col gap-(--hd-space-2)">
              <CodeText>{edit2.path}</CodeText>
              <DiffView diff={edit2.before === null ? edit2.after : wholeTextDiff(edit2.before, edit2.after)} wholeFile={edit2.before === null} wrap />
            </div>
          ))}
        </>
      )}
    </Dialog>
  )
}
