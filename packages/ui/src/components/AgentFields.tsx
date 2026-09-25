import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'

import {
  CEILING_LEVELS,
  SEAT_PREFERENCE_LIMIT,
  type AgentEntry,
  type AgentFieldEdit,
  type AuthoringDocument,
  type AuthoringSavePreview,
  type CeilingLevel,
  type FlowSeat,
  type WritableAuthoringTarget,
} from '@harnessdesk/protocol'

import { agentName, ceilingMeaning, ceilingWords, wordList } from '../lib/agents'
import {
  Banner, BoardMenuButton, Button, CodeText, Dialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger, Field, Input, Note, Row, RowChoice, Rows, SectionHead, Textarea,
} from '../design'
import { useSnapshot, useStore } from '../state/context'
import { MoveDownIcon, MoveUpIcon, PlusIcon, TrashIcon } from './Icons'
import { DiffView } from './Diff'

/**
 * The Agent page's editable metadata — name, description, ceiling, what it
 * answers and produces, and the ordered seats it prefers — each a row (or,
 * for ceiling and prefer, the page's own existing row) that opens a small
 * dialog: type or choose, see the exact line this would write, then Save.
 *
 * Ceiling and prefer are edited through this same `authoring/*` preview/save
 * path, but their dialogs (`FieldEditDialog` with `fieldKey="ceiling"`, and
 * `PreferFieldDialog`) are exported for `AgentPage` to open directly,
 * alongside the rows that already exist there — the legacy `permission:`
 * Update action (`CeilingUpdate`) and the Seats section — rather than
 * duplicated here: `AgentPage` already holds `agentDocument`'s digest, and a
 * second "Ceiling" row in this file would either race that one or repeat it.
 * The server's own gate is the only judge of whether a ceiling edit is
 * legacy-blocked (`editAgentSource`'s `ceilingFrom === 'permission'` check) —
 * this file never re-checks that itself; a refused preview just shows the
 * host's own words, which already say to use the existing Update action.
 *
 * A built-in Agent shows the same rows with no *Edit…*: `entry.origin`
 * decides, exactly like *Customize…* and *Remove…* already do above.
 */
export interface AgentFieldsProps {
  readonly document: AuthoringDocument
  readonly entry: AgentEntry
  readonly busy: boolean
  /** Told once a field's write has actually landed, so the caller can re-read the entry and the document. */
  readonly onEdit: (edit: AgentFieldEdit) => void
  readonly onOpenFile: () => void
}

type FieldKey = 'name' | 'description' | 'answers' | 'produces' | 'ceiling'

const LABEL: Readonly<Record<FieldKey, string>> = {
  name: 'Name',
  description: 'Description',
  answers: 'Answers',
  produces: 'Produces',
  ceiling: 'Ceiling',
}

export const AgentFields = ({ document, entry, busy, onEdit, onOpenFile }: AgentFieldsProps) => {
  const [editing, setEditing] = useState<FieldKey | null>(null)
  const definition = entry.definition
  if (!definition) return null
  const editable = entry.origin !== 'builtin'
  const target = document.target as Extract<WritableAuthoringTarget, { readonly kind: 'agent' }>

  const row = (key: FieldKey, value: string): ReactElement => (
    <Row
      key={key}
      title={LABEL[key]}
      wrapDesc
      desc={value || '—'}
      control={editable ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(key)}>
          Edit…
        </Button>
      ) : undefined}
    />
  )

  return (
    <>
      <SectionHead name="Identity" />
      <Rows>
        {row('name', definition.name)}
        {row('description', definition.description ?? '')}
      </Rows>
      <SectionHead name="What it hands back" />
      <Rows>
        {row('answers', wordList(definition.answers))}
        {row('produces', wordList(definition.produces))}
      </Rows>
      {editing && (
        <FieldEditDialog
          fieldKey={editing}
          target={target}
          digest={document.digest}
          initial={editing === 'name' ? definition.name : editing === 'description' ? (definition.description ?? '') : definition[editing]}
          onOpenFile={onOpenFile}
          onClose={() => setEditing(null)}
          onSaved={(edit) => {
            setEditing(null)
            onEdit(edit)
          }}
        />
      )}
    </>
  )
}

/** One field's value, as `AgentFieldEdit` writes it — a string for the single-line rows, an ordered list for the two word lists, one of the four words for ceiling. */
const buildEdit = (key: FieldKey, text: string): AgentFieldEdit => {
  if (key === 'answers' || key === 'produces') return { key, value: text.split('\n').map((line) => line.trim()).filter(Boolean) }
  if (key === 'ceiling') return { key, value: text as CeilingLevel }
  return { key, value: text }
}

const multiline = (key: FieldKey): boolean => key === 'answers' || key === 'produces'

/**
 * A minimal unified diff between two whole-file texts that differ in one
 * short run of lines — a splice touches one line, an insertion touches none
 * before it and one after. Built here rather than pulled from a dependency:
 * the runtime already hands every *other* diff in this app to us finished,
 * and this one is small and single-purpose enough not to need one either.
 */
const lineDiff = (path: string, before: string, after: string): string => {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const context = 1
  const ctxStart = Math.max(0, start - context)
  const ctxEnd = Math.min(Math.max(endA, endB) + context, Math.max(a.length, b.length))
  const lines: string[] = []
  for (let index = ctxStart; index < start; index += 1) lines.push(` ${a[index] ?? ''}`)
  for (let index = start; index < endA; index += 1) lines.push(`-${a[index] ?? ''}`)
  for (let index = start; index < endB; index += 1) lines.push(`+${b[index] ?? ''}`)
  for (let index = endA; index < ctxEnd && index < a.length; index += 1) lines.push(` ${a[index] ?? ''}`)
  const oldLines = (endA - ctxStart) + Math.max(0, Math.min(ctxEnd, a.length) - endA)
  const newLines = (endB - ctxStart) + Math.max(0, Math.min(ctxEnd, b.length) - endA)
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${ctxStart + 1},${oldLines} +${ctxStart + 1},${newLines} @@\n${lines.join('\n')}\n`
}

/**
 * Preview-then-write for exactly one field, bound to the digest the page
 * read this Agent at. Every keystroke re-previews (like `CeilingUpdate`); the
 * *Save* here is the explicit write `docs/decisions.md` calls for, applying
 * the last preview's token. A stale-file conflict offers *Reload*, which
 * re-reads the document for a fresh digest without discarding what was
 * typed; a field that spans lines in the file (a block scalar) refuses the
 * same way and offers *Open file* instead — the same host refusal covers
 * both, so this dialog does not have to know which is which beforehand.
 */
export const FieldEditDialog = ({
  fieldKey,
  target,
  digest,
  initial,
  onOpenFile,
  onClose,
  onSaved,
}: {
  readonly fieldKey: FieldKey
  readonly target: Extract<WritableAuthoringTarget, { readonly kind: 'agent' }>
  readonly digest: string
  readonly initial: string | readonly string[]
  readonly onOpenFile: () => void
  readonly onClose: () => void
  readonly onSaved: (edit: AgentFieldEdit) => void
}) => {
  const store = useStore()
  const [text, setText] = useState(Array.isArray(initial) ? initial.join('\n') : (initial as string))
  const [expected, setExpected] = useState(digest)
  const [preview, setPreview] = useState<AuthoringSavePreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reloading, setReloading] = useState(false)
  const sequence = useRef(0)
  const applying = useRef(false)

  useEffect(() => {
    const mine = ++sequence.current
    setPreview(null)
    setProblem(null)
    const edit = buildEdit(fieldKey, text)
    store.previewAgentEdit(target, expected, edit).then(
      (next) => {
        if (mine === sequence.current) setPreview(next)
      },
      (error: unknown) => {
        if (mine === sequence.current) setProblem(error instanceof Error ? error.message : String(error))
      },
    )
  }, [fieldKey, target, expected, text, store])

  const issue = preview?.issues[0] ?? null
  // The host's own two fixes for a refused field: opening the file (a value
  // that spans lines, or cannot be read at all) and reloading it (someone
  // else's write landed first). Matched on the fix's own words, which the
  // host already chose for exactly this row to show — not on the far more
  // varied issue text above it.
  const offersOpenFile = issue?.fix.toLowerCase().includes('open the file') ?? false
  const offersReload = issue?.fix.toLowerCase().includes('reload') ?? false

  const reload = async (): Promise<void> => {
    setReloading(true)
    setProblem(null)
    try {
      const fresh = await store.readAuthoring(target)
      setExpected(fresh.digest)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setReloading(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!preview?.token || applying.current) return
    applying.current = true
    setBusy(true)
    setProblem(null)
    try {
      const result = await store.applyAuthoringSave(preview.token)
      if (result.state !== 'applied') {
        applying.current = false
        setBusy(false)
        setProblem(result.message)
        return
      }
      onSaved(buildEdit(fieldKey, text))
    } catch (error) {
      applying.current = false
      setBusy(false)
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }

  const edit = preview?.edits[0] ?? null

  return (
    <Dialog
      title={`Edit ${LABEL[fieldKey]}`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="default" disabled={busy || !preview?.token} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      {fieldKey === 'ceiling' ? (
        <Rows role="radiogroup" aria-label="Ceiling">
          {CEILING_LEVELS.map((level) => (
            <RowChoice
              key={level}
              title={ceilingWords(level)}
              desc={<span className="whitespace-normal">{ceilingMeaning(level)}</span>}
              selected={text === level}
              disabled={busy}
              onClick={() => setText(level)}
            />
          ))}
        </Rows>
      ) : (
        <Field
          label={LABEL[fieldKey]}
          {...(multiline(fieldKey) ? { hint: 'One per line, in the order they should be written.' } : {})}
        >
          {(control): ReactNode =>
            multiline(fieldKey) ? (
              <Textarea {...control} rows={5} disabled={busy} value={text} onChange={(event) => setText(event.target.value)} />
            ) : (
              <Input {...control} disabled={busy} value={text} onChange={(event) => setText(event.target.value)} />
            )
          }
        </Field>
      )}
      {problem && <Banner tone="danger" title="This could not be saved">{problem}</Banner>}
      {issue && (
        <Banner tone={offersReload ? 'warning' : 'danger'} title={issue.text}>
          <span className="flex flex-col items-start gap-(--hd-space-2)">
            {issue.fix}
            {offersOpenFile && (
              <Button size="sm" variant="outline" onClick={onOpenFile}>
                Open file
              </Button>
            )}
            {offersReload && (
              <Button size="sm" variant="outline" disabled={reloading} onClick={() => void reload()}>
                {reloading ? 'Reloading…' : 'Reload'}
              </Button>
            )}
          </span>
        </Banner>
      )}
      {edit && !issue && (
        <div className="space-y-2">
          <CodeText>{edit.path}</CodeText>
          <Note>The exact line this would write:</Note>
          <DiffView diff={lineDiff(edit.path, edit.before ?? '', edit.after)} wrap />
        </div>
      )}
    </Dialog>
  )
}

/** A seat's own presentation name — never a raw runtime id in the row a person reads. */
const seatRuntimeName = (
  seat: FlowSeat,
  runtimes: readonly { readonly id: string; readonly presentation: { readonly name: string } }[],
): string => runtimes.find((one) => one.id === seat.runtime)?.presentation.name ?? seat.runtime

/**
 * `prefer`, edited as the ordered list it is — through the same
 * `authoring/*` preview/save path as every other field here, previewed on
 * every change and written only by the explicit *Save* below.
 *
 * Adding a seat here names a runtime only, matching decision 15's project
 * portability rule (an exact model stays out of a saved preference) — the
 * existing *On this Mac* editor (`AddSeatDialog`, above, on this Mac's own
 * seating) is still where an exact model, effort or thinking mode is chosen;
 * this list is what travels with the Agent. An existing entry that already
 * names one, from the file, is kept exactly as it reads until it is removed.
 */
export const PreferFieldDialog = ({
  entry,
  target,
  digest,
  initial,
  onOpenFile,
  onClose,
  onSaved,
}: {
  readonly entry: AgentEntry
  readonly target: Extract<WritableAuthoringTarget, { readonly kind: 'agent' }>
  readonly digest: string
  readonly initial: readonly FlowSeat[]
  readonly onOpenFile: () => void
  readonly onClose: () => void
  readonly onSaved: (edit: AgentFieldEdit) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [seats, setSeats] = useState<readonly FlowSeat[]>(initial)
  const [expected, setExpected] = useState(digest)
  const [preview, setPreview] = useState<AuthoringSavePreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reloading, setReloading] = useState(false)
  const sequence = useRef(0)
  const applying = useRef(false)

  useEffect(() => {
    const mine = ++sequence.current
    setPreview(null)
    setProblem(null)
    store.previewAgentEdit(target, expected, { key: 'prefer', value: seats }).then(
      (next) => {
        if (mine === sequence.current) setPreview(next)
      },
      (error: unknown) => {
        if (mine === sequence.current) setProblem(error instanceof Error ? error.message : String(error))
      },
    )
  }, [target, expected, seats, store])

  const issue = preview?.issues[0] ?? null
  const offersOpenFile = issue?.fix.toLowerCase().includes('open the file') ?? false
  const offersReload = issue?.fix.toLowerCase().includes('reload') ?? false

  const reload = async (): Promise<void> => {
    setReloading(true)
    setProblem(null)
    try {
      const fresh = await store.readAuthoring(target)
      setExpected(fresh.digest)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setReloading(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!preview?.token || applying.current) return
    applying.current = true
    setBusy(true)
    setProblem(null)
    try {
      const result = await store.applyAuthoringSave(preview.token)
      if (result.state !== 'applied') {
        applying.current = false
        setBusy(false)
        setProblem(result.message)
        return
      }
      onSaved({ key: 'prefer', value: seats })
    } catch (error) {
      applying.current = false
      setBusy(false)
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }

  const move = (index: number, delta: number): void => {
    const to = index + delta
    if (to < 0 || to >= seats.length) return
    const next = [...seats]
    ;[next[index], next[to]] = [next[to]!, next[index]!]
    setSeats(next)
  }
  const removeAt = (index: number): void => setSeats(seats.filter((_, one) => one !== index))
  /** Names a runtime only — matching decision 15's project-portability rule, above. Chosen directly from the menu; no separate confirming step. */
  const addSeat = (runtime: string): void => {
    if (seats.length >= SEAT_PREFERENCE_LIMIT) return
    setSeats([...seats, { runtime }])
  }

  const edit = preview?.edits[0] ?? null

  return (
    <Dialog
      title={`Edit Seats for ${agentName(entry)}`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="default" disabled={busy || !preview?.token} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <Note>In the order it asks for them. The first this Mac can offer is the one it takes.</Note>
      <Rows aria-label="Preferred seats">
        {seats.length === 0 && <Row title="It prefers no seat yet" />}
        {seats.map((seat, index) => (
          <Row
            key={`${seat.runtime}-${index}`}
            title={seatRuntimeName(seat, snapshot.runtimes)}
            desc={[seat.model, seat.effort, seat.thinking ? 'thinking' : null].filter(Boolean).join(' · ') || undefined}
            control={(
              <DropdownMenu>
                <DropdownMenuTrigger disabled={busy} render={<BoardMenuButton aria-label={`${seatRuntimeName(seat, snapshot.runtimes)} seat actions`} disabled={busy} />} />
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={index === 0} onClick={() => move(index, -1)}>
                    <MoveUpIcon size={14} />
                    Move up
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={index === seats.length - 1} onClick={() => move(index, 1)}>
                    <MoveDownIcon size={14} />
                    Move down
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => removeAt(index)}>
                    <TrashIcon size={14} />
                    Remove seat
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          />
        ))}
      </Rows>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={busy || seats.length >= SEAT_PREFERENCE_LIMIT}
          render={(
            <Button size="sm" variant="outline" disabled={busy || seats.length >= SEAT_PREFERENCE_LIMIT}>
              <PlusIcon size={14} />
              Add a seat
            </Button>
          )}
        />
        <DropdownMenuContent align="start">
          {snapshot.runtimes.map((one) => (
            <DropdownMenuItem key={one.id} onClick={() => addSeat(one.id)}>
              {one.presentation.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Note>
        Adding here names a runtime only, so this list stays portable. An exact model, effort or thinking mode is
        chosen on this Mac&rsquo;s own seating (the *On this Mac* section of this page), or by editing the file
        directly.
      </Note>
      {problem && <Banner tone="danger" title="This could not be saved">{problem}</Banner>}
      {issue && (
        <Banner tone={offersReload ? 'warning' : 'danger'} title={issue.text}>
          <span className="flex flex-col items-start gap-(--hd-space-2)">
            {issue.fix}
            {offersOpenFile && (
              <Button size="sm" variant="outline" onClick={onOpenFile}>
                Open file
              </Button>
            )}
            {offersReload && (
              <Button size="sm" variant="outline" disabled={reloading} onClick={() => void reload()}>
                {reloading ? 'Reloading…' : 'Reload'}
              </Button>
            )}
          </span>
        </Banner>
      )}
      {edit && !issue && (
        <div className="space-y-2">
          <CodeText>{edit.path}</CodeText>
          <Note>The exact line this would write:</Note>
          <DiffView diff={lineDiff(edit.path, edit.before ?? '', edit.after)} wrap />
        </div>
      )}
    </Dialog>
  )
}

/**
 * Where a later phase's own section of the Agent page mounts: after the core
 * metadata this file and the page above it already draw, before the file's
 * own actions (Brief, Open file, Reveal). Phase 11 fills it with cost; phase
 * 12, with skills, servers and notes. It carries no write path of its own —
 * a section validates and saves through its own domain, never through a
 * callback this grants it.
 */
export interface AgentPageSectionsProps {
  readonly entry: AgentEntry
  readonly children: ReactNode
}

export const AgentPageSections = ({ children }: AgentPageSectionsProps): ReactElement => <>{children}</>
