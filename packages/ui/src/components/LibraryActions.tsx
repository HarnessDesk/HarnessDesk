import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  Library,
  LibraryCopy,
  LibraryEntry,
  LibraryIntent,
  LibraryOpResult,
  LibraryPlan,
  LibraryPlannedOp,
  RuntimeId,
} from '@harnessdesk/protocol'

import { useStore } from '../state/context'
import { Btn, Dialog, Input } from '../design'
import { Checkbox, ToggleGroup, ToggleGroupItem } from '../design/ui'
import { RuntimeMark } from './BrandIcons'
import { shortPath } from '../lib/paths'
import { DiffView } from './Diff'
import {
  AlertIcon,
  CheckIcon,
  ChevronIcon,
  CrossIcon,
  ImportIcon,
  PlusIcon,
} from './Icons'
import { kit } from '../design/primitives/Kit'
import styles from './LibraryActions.module.css'

/**
 * The library's verbs: install, import, resolve, author, remove.
 *
 * Every one of them funnels through the same two-step surface — `PlanDialog`
 * asks the host to plan, shows each operation with its diff, and only then
 * applies. The dialog never invents an outcome: `skip` and `refuse` arrive
 * from the host with their reasons and are shown, not filtered, because a
 * batch that quietly drops half its rows is how an import reports success
 * while failing. After apply, every operation wears its own result.
 *
 * What this file never does is compute a write itself. The renderer builds
 * *intents* — names, paths it read from the library, a chosen target — and
 * everything about what would actually happen (the exact file, the diff, the
 * refusals) comes back from the host, which checks it all again at apply.
 */

export interface LibraryColumn {
  readonly id: RuntimeId
  readonly label: string
  /**
   * The registered runtime behind the column, where there is one — what the
   * brand mark is drawn from. Optional because a column can outlive its
   * registration: the library reports whatever the host found on disk, and a
   * skill installed for an agent since removed still has a column with no
   * runtime to draw. The mark falls back to the generic agent glyph rather
   * than the column disappearing, because the copy is still there.
   */
  readonly info?: {
    readonly id: string
    readonly presentation: { readonly name: string; readonly brand?: string }
  }
}

export type LibraryFlow =
  | { readonly type: 'import' }
  | { readonly type: 'author' }
  | { readonly type: 'resolve'; readonly entry: LibraryEntry }
  | { readonly type: 'plan'; readonly title: string; readonly intents: readonly LibraryIntent[] }

/**
 * The copy an install reads from: loadable, and preferably one some agent
 * actually loads — a stranded copy can still be the source when it is the
 * only one, which is exactly the rescue the `.agents` strays need.
 */
export const installSource = (entry: LibraryEntry): LibraryCopy | null => {
  const loadable = entry.copies.filter((copy) => !copy.hollow)
  return loadable.find((copy) => copy.readBy.length > 0) ?? loadable[0] ?? null
}

/**
 * The copy an import *from this agent* carries: the one that agent reads.
 * "Import from Codex" taking some other agent's copy of the same name would
 * be a quiet substitution, however similar the two look.
 */
export const sourceCopy = (entry: LibraryEntry, source: RuntimeId): LibraryCopy | null =>
  entry.copies.find((copy) => !copy.hollow && copy.readBy.includes(source)) ??
  installSource(entry)

const RUNNABLE = new Set(['create', 'update', 'replace', 'remove'])

/** What one planned operation says it will do, in one sentence. */
const verbOf = (op: LibraryPlannedOp, columns: readonly LibraryColumn[]): string => {
  const target = columns.find((one) => one.id === op.targetRuntime)?.label
  const where = target ?? op.targetPath
  switch (op.action) {
    case 'create':
      return `New for ${where}`
    case 'update':
      return target ? `Update the copy ${target} reads` : 'Update the copy'
    // The path used to be inside these sentences and is now beside them, in
    // `.opPath`, where every op has it in the same place instead of three
    // ops having it three different ways and a fourth not at all.
    case 'replace':
      return target ? `Replace the copy ${target} reads` : 'Replace the copy'
    case 'remove':
      return target ? `Remove the copy ${target} reads` : 'Remove the copy'
    case 'skip':
      return op.reason ?? 'Nothing to do'
    case 'refuse':
      return op.reason ?? 'Refused'
  }
}

const Mark = ({ op, result }: { op: LibraryPlannedOp; result?: LibraryOpResult }) => {
  if (result) {
    if (result.outcome === 'done') return <CheckIcon size={13} />
    if (result.outcome === 'failed') return <CrossIcon size={13} />
    return <span className={styles.skipMark}>·</span>
  }
  if (op.action === 'refuse') return <AlertIcon size={13} />
  if (op.action === 'skip') return <span className={styles.skipMark}>·</span>
  return <span className={styles.planned} />
}

/**
 * Plan → preview → apply, with per-op results.
 *
 * All ops go to apply, runnable or not: the skipped and refused ones come
 * back as `skipped` with their reasons, so the record the audit log keeps is
 * the record the person saw.
 */
export const PlanDialog = ({
  title,
  intents,
  columns,
  cwd,
  home,
  onClose,
  onApplied,
}: {
  title: string
  intents: readonly LibraryIntent[]
  columns: readonly LibraryColumn[]
  cwd?: string | undefined
  /** The host's home, so every path here prints the way it is written. */
  home?: string | undefined
  onClose: () => void
  onApplied: () => void
}) => {
  const store = useStore()
  const [plan, setPlan] = useState<LibraryPlan | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<readonly LibraryOpResult[] | null>(null)

  useEffect(() => {
    let cancelled = false
    store.transport
      .request('library/plan', { intents, ...(cwd ? { cwd } : {}) })
      .then((answer) => {
        if (!cancelled) setPlan(answer)
      })
      .catch((error) => {
        if (!cancelled) setFailed(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [store, intents, cwd])

  const runnable = useMemo(
    () => (plan?.ops ?? []).filter((op) => RUNNABLE.has(op.action)),
    [plan],
  )

  const apply = useCallback(async () => {
    if (!plan) return
    setBusy(true)
    try {
      const answer = await store.transport.request('library/apply', {
        ops: plan.ops,
        ...(cwd ? { cwd } : {}),
      })
      setResults(answer)
      if (answer.some((one) => one.outcome === 'done')) onApplied()
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [plan, store, cwd, onApplied])

  const resultOf = (id: string) => results?.find((one) => one.id === id)
  const done = results?.filter((one) => one.outcome === 'done').length ?? 0
  const failedCount = results?.filter((one) => one.outcome === 'failed').length ?? 0

  return (
    <Dialog
      title={title}
      icon={<ImportIcon size={16} />}
      /*
       * `xl`, and deliberately not `tall`.
       *
       * Wide because what this dialog exists to show is a unified diff, and
       * 620 is the width this app already gives "a list you read".
       *
       * Not `tall` because `tall` is a *floor* as well as a ceiling — right
       * for a list you walk into and out of, wrong here: the overwhelmingly
       * common plan is one operation, and it sat in a 560px box with three
       * hundred pixels of nothing under it, which is what an unfinished
       * screen looks like. Without the floor the surface fits its content
       * and the base dialog's own ceiling still catches a long plan.
       */
      size="xl"
      onClose={onClose}
      subhead={
        results ? (
          <p className={styles.summary} data-testid="apply-summary">
            {done} {done === 1 ? 'change' : 'changes'} made
            {failedCount > 0 ? `, ${failedCount} failed` : ''}
            {results.length - done - failedCount > 0
              ? `, ${results.length - done - failedCount} skipped`
              : ''}
            .
          </p>
        ) : plan ? (
          <p className={styles.summary}>
            {runnable.length === 0
              ? 'Nothing to change — every row says why.'
              : `${runnable.length} ${runnable.length === 1 ? 'change' : 'changes'}, previewed below. Nothing has happened yet.`}
          </p>
        ) : undefined
      }
      footer={
        results ? (
          <Btn variant="primary" onClick={onClose}>
            Close
          </Btn>
        ) : (
          <>
            <Btn
              variant="primary"
              disabled={busy || !plan || runnable.length === 0}
              onClick={() => void apply()}
            >
              {busy
                ? 'Applying…'
                : `Apply ${runnable.length} ${runnable.length === 1 ? 'change' : 'changes'}`}
            </Btn>
            <Btn onClick={onClose} disabled={busy}>
              Cancel
            </Btn>
          </>
        )
      }
    >
      {failed !== null ? (
        <p className={styles.failed}>{failed}</p>
      ) : !plan ? (
        <p className={styles.loading}>Working out exactly what would change…</p>
      ) : plan.ops.length === 0 ? (
        <p className={styles.loading}>Nothing to do.</p>
      ) : (
        <ul className={styles.ops}>
          {plan.ops.map((op) => {
            const result = resultOf(op.id)
            const expandable = op.preview !== undefined && op.preview !== ''
            return (
              <li key={op.id} className={styles.op} data-action={op.action}>
                <button
                  type="button"
                  className={styles.opHead}
                  onClick={() => expandable && setOpen((current) => (current === op.id ? null : op.id))}
                  aria-expanded={open === op.id}
                  disabled={!expandable}
                >
                  <span
                    className={styles.opMark}
                    data-state={result?.outcome ?? op.action}
                  >
                    <Mark op={op} {...(result ? { result } : {})} />
                  </span>
                  <span className={styles.opName}>{op.name}</span>
                  <span
                    className={styles.opVerb}
                    {...(op.action === 'refuse' || result?.outcome === 'failed'
                      ? { 'data-wrap': '' }
                      : {})}
                    title={result?.outcome === 'failed' ? result.detail : verbOf(op, columns)}
                  >
                    {result?.outcome === 'failed' ? result.detail : verbOf(op, columns)}
                  </span>
                  {op.targetPath !== undefined && op.targetPath !== '' && (
                    <span className={styles.opPath} title={op.targetPath}>
                      {shortPath(op.targetPath, home)}
                    </span>
                  )}
                  {expandable && (
                    <span className={styles.opChev} data-open={open === op.id ? '' : undefined}>
                      <ChevronIcon size={13} />
                    </span>
                  )}
                </button>
                {open === op.id && op.preview && (
                  <div className={styles.opBody}>
                    <DiffView diff={op.preview} wrap />
                    {op.extraFiles && op.extraFiles.length > 0 && (
                      <p className={styles.opFiles}>
                        Also carries {op.extraFiles.length}{' '}
                        {op.extraFiles.length === 1 ? 'bundle file' : 'bundle files'}:{' '}
                        <code className={kit.mono}>{op.extraFiles.slice(0, 4).join(', ')}</code>
                        {op.extraFiles.length > 4 ? '…' : ''}
                      </p>
                    )}
                    {op.backup && (
                      <p className={styles.opFiles}>
                        The current copy is backed up before this happens.
                      </p>
                    )}
                    {result?.backupPath && (
                      <p className={styles.opFiles}>
                        Backed up to <code className={kit.mono}>{result.backupPath}</code>
                      </p>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Dialog>
  )
}

/** One agent picked out of the columns; a segmented row, not a dropdown. */
/**
 * The switcher this app draws when one of several things is chosen: a filled
 * track, and the chosen one raised out of it on a card.
 *
 * Named here, once, and used by all three of them — the kind tabs, the
 * list/matrix switch, and the two agent pickers below. The first two were
 * already the same control written two ways (`rounded-md bg-muted` against
 * `rounded-(--hd-radius-sm) bg-(--hd-muted)`), which resolve to the same
 * pixels today and are two things to keep in step forever. Three copies is
 * where that stops being survivable.
 */
export const SWITCH_TRACK = 'h-(--hd-control-h) rounded-(--hd-radius-sm) bg-(--hd-muted) p-0.5'
export const SWITCH_ITEM =
  'h-full gap-1.5 rounded-(--hd-radius-sm) px-2 text-sm font-medium whitespace-nowrap text-(--hd-muted-foreground) hover:bg-transparent hover:text-(--hd-foreground) data-[state=on]:bg-(--hd-card) data-[state=on]:text-(--hd-foreground) data-[state=on]:shadow-(--hd-shadow-sm)'

/**
 * Which agent, of the ones on this machine.
 *
 * It was a row of bare pills of its own making, and their unselected border
 * was `--hd-border` — four percent black, which on a dialog's white ground is
 * nothing at all. So the first thing a person saw after pressing "Review in
 * Library" on the startup banner was four agent names in plain text, no
 * chrome, no affordance, with the confirm button greyed out and no way to
 * tell that the names were the thing to press. The selected state then jumped
 * to full ink, a twenty-five-fold step, which is the signature of a control
 * that was drawn rather than chosen.
 *
 * It is now the switcher the page already uses twice above it, so it is
 * visible at rest, keyboard-navigable as a radio group, and carries each
 * agent's own mark — which is how every other surface in the app names an
 * agent.
 *
 * **Nothing here is disabled**, and that is a fix rather than an oversight.
 * The other side's choice used to be greyed out in each picker, which reads
 * as "not that one" and works — until the machine has exactly two agents.
 * Then From holds A with B greyed, To holds B with A greyed, pressing the
 * one already chosen is ignored (that is what stops a stray click emptying
 * the picker), and there is no press anywhere that reverses the direction.
 * A person with Claude and Cursor could import one way and never the other.
 * The caller swaps instead; see `ImportDialog`.
 */
const AgentPick = ({
  columns,
  value,
  onChange,
  label,
}: {
  columns: readonly LibraryColumn[]
  value: RuntimeId | null
  onChange: (next: RuntimeId) => void
  label: string
}) => (
  <ToggleGroup
    type="single"
    value={value ?? ''}
    aria-label={label}
    className={SWITCH_TRACK}
    onValueChange={(next) => {
      // An empty value is the second press on the chosen one. Ignoring it is
      // what stops a picker whose whole job is to hold a choice from being
      // emptied by a stray click.
      if (next === '' || next === null) return
      onChange(next as RuntimeId)
    }}
  >
    {columns.map((column) => (
      <ToggleGroupItem key={column.id} value={column.id} className={SWITCH_ITEM}>
        {column.info && <RuntimeMark runtime={column.info} size={13} />}
        {column.label}
      </ToggleGroupItem>
    ))}
  </ToggleGroup>
)

/**
 * The bulk import: everything one agent can load that another cannot,
 * offered as a checked list. What comes out is intents; every path decision
 * and every refusal belongs to the host's plan.
 */
export const ImportDialog = ({
  library,
  columns,
  onClose,
  onPlan,
}: {
  library: Library
  columns: readonly LibraryColumn[]
  onClose: () => void
  onPlan: (title: string, intents: readonly LibraryIntent[]) => void
}) => {
  const [source, setSource] = useState<RuntimeId | null>(null)
  const [target, setTarget] = useState<RuntimeId | null>(null)

  /**
   * Choosing one side swaps rather than collides.
   *
   * Picking the agent that is currently the *other* side is not a mistake to
   * refuse — it is the plainest way a person says "the other direction", and
   * on a two-agent machine it is the only way. So it reverses the pair, and
   * the same press means the same thing from either picker.
   */
  const pickSource = (next: RuntimeId) => {
    if (next === target) setTarget(source)
    setSource(next)
  }
  const pickTarget = (next: RuntimeId) => {
    if (next === source) setSource(target)
    setTarget(next)
  }
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set())

  const candidates = useMemo(() => {
    if (source === null || target === null || source === target) return []
    const sourceIndex = library.runtimes.indexOf(source)
    const targetIndex = library.runtimes.indexOf(target)
    if (sourceIndex === -1 || targetIndex === -1) return []
    return library.entries.filter((entry) => {
      if (entry.reach[sourceIndex]?.state !== 'reaches') return false
      const at = entry.reach[targetIndex]?.state
      if (at !== 'absent' && at !== 'unscanned') return false
      // Anything can only land where the agent has somewhere to keep it —
      // a skills directory, or a config file for its servers. The plan would
      // refuse each of these with a reason, but a list that needs its
      // preview to walk it back was offering too much.
      if (!library.locations.some((one) => one.runtime === target && one.kind === entry.kind)) {
        return false
      }
      if (entry.kind === 'skill') {
        const loadable = entry.copies.filter((copy) => !copy.hollow)
        // Disagreeing copies have no one truth to carry; the row's Resolve
        // flow settles that first, so the bulk import never picks silently.
        if (new Set(loadable.map((copy) => copy.digest)).size > 1) return false
        const copy = sourceCopy(entry, source)
        return copy !== null && !copy.readOnly
      }
      return entry.copies.some((copy) => copy.readBy.includes(source))
    })
  }, [library, source, target])

  const picked = candidates.filter((entry) => !excluded.has(`${entry.kind}:${entry.name}`))

  const go = () => {
    if (target === null) return
    const intents: LibraryIntent[] = []
    for (const entry of picked) {
      if (entry.kind === 'skill') {
        const copy = source === null ? null : sourceCopy(entry, source)
        if (copy) {
          intents.push({
            kind: 'installSkill',
            name: entry.name,
            sourcePath: copy.path,
            targetRuntime: target,
          })
        }
      } else {
        const copy = entry.copies.find((one) => source !== null && one.readBy.includes(source))
        if (copy) {
          intents.push({
            kind: 'installMcp',
            name: entry.name,
            sourcePath: copy.path,
            targetRuntime: target,
          })
        }
      }
    }
    const label = columns.find((one) => one.id === target)?.label ?? 'the agent'
    onPlan(`Import into ${label}`, intents)
  }

  return (
    <Dialog
      title="Import between agents"
      icon={<ImportIcon size={16} />}
      size="lg"
      tall
      onClose={onClose}
      subhead={
        <div className={styles.pickPair}>
          <div className={styles.pickCol}>
            <span className={styles.pickLabel}>From</span>
            <AgentPick columns={columns} value={source} onChange={pickSource} label="Import from" />
          </div>
          <div className={styles.pickCol}>
            <span className={styles.pickLabel}>To</span>
            <AgentPick columns={columns} value={target} onChange={pickTarget} label="Import into" />
          </div>
        </div>
      }
      footer={
        <>
          <Btn variant="primary" disabled={picked.length === 0} onClick={go}>
            {picked.length === 0
              ? 'Preview'
              : `Preview ${picked.length} ${picked.length === 1 ? 'import' : 'imports'}`}
          </Btn>
          <Btn onClick={onClose}>Cancel</Btn>
        </>
      }
    >
      {source === null || target === null ? (
        <p className={styles.loading}>
          Pick where to import from, and which agent should get it. Nothing changes until a
          preview is confirmed.
        </p>
      ) : candidates.length === 0 ? (
        <p className={styles.loading}>
          {library.locations.some((one) => one.runtime === target)
            ? 'Nothing to import — everything the source loads already reaches the target, or cannot be carried faithfully (those rows say so in the table).'
            : `Nothing can be carried to ${columns.find((one) => one.id === target)?.label ?? 'this agent'} yet — this build does not know where it keeps skills or servers.`}
        </p>
      ) : (
        <>
          <div className={styles.bulk}>
            <Btn small onClick={() => setExcluded(new Set())}>
              All
            </Btn>
            <Btn
              small
              onClick={() =>
                setExcluded(new Set(candidates.map((entry) => `${entry.kind}:${entry.name}`)))
              }
            >
              None
            </Btn>
          </div>
          <ul className={styles.candidates}>
            {candidates.map((entry) => {
              const key = `${entry.kind}:${entry.name}`
              const on = !excluded.has(key)
              return (
                <li key={key} className={styles.candidate}>
                  {/* A checkbox, not a switch. A switch says "this setting is
                      on now"; nothing here is on until Preview is confirmed,
                      and every one of these rows is an item being picked out
                      of a list. The two controls are not interchangeable and
                      the app has both. */}
                  <Checkbox
                    checked={on}
                    aria-label={`Import ${entry.name}`}
                    onCheckedChange={() =>
                      setExcluded((current) => {
                        const next = new Set(current)
                        if (on) next.add(key)
                        else next.delete(key)
                        return next
                      })
                    }
                  />
                  <span className={styles.candidateName}>{entry.title ?? entry.name}</span>
                  {entry.kind === 'mcp' && <span className={styles.candidateKind}>MCP</span>}
                  {entry.description && (
                    <span className={styles.candidateDesc}>{entry.description}</span>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Dialog>
  )
}

/**
 * De-dupe: the copies disagree, one is declared the winner, and the plan
 * shows what happens to each loser. The winner is a choice the person makes;
 * pre-selecting one would be this dialog deciding what the person meant.
 */
export const ResolveDialog = ({
  entry,
  columns,
  home,
  onClose,
  onPlan,
}: {
  entry: LibraryEntry
  columns: readonly LibraryColumn[]
  home?: string | undefined
  onClose: () => void
  onPlan: (title: string, intents: readonly LibraryIntent[]) => void
}) => {
  const [winner, setWinner] = useState<string | null>(null)
  const loadable = entry.copies.filter((copy) => !copy.hollow && !copy.readOnly)
  const hollow = entry.copies.filter((copy) => copy.hollow && !copy.readOnly)
  const [cleanHollow, setCleanHollow] = useState(true)

  const go = () => {
    if (winner === null) return
    const intents: LibraryIntent[] = [
      {
        kind: 'syncSkill',
        name: entry.name,
        sourcePath: winner,
        targetPaths: loadable.filter((copy) => copy.path !== winner).map((copy) => copy.path),
      },
      ...(cleanHollow
        ? hollow.map((copy) => ({ kind: 'removeCopy' as const, name: entry.name, path: copy.path }))
        : []),
    ]
    onPlan(`Resolve the copies of ${entry.name}`, intents)
  }

  return (
    <Dialog
      title={`Resolve ${entry.title ?? entry.name}`}
      icon={<AlertIcon size={16} />}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Btn variant="primary" disabled={winner === null} onClick={go}>
            Preview the resolution
          </Btn>
          <Btn onClick={onClose}>Cancel</Btn>
        </>
      }
    >
      <p className={styles.blurb}>
        The copies of this skill disagree, so which one an agent runs depends on scan order. Pick
        the copy that should win; every other copy is rewritten to match it, and each one replaced
        is backed up first.
      </p>
      <ul className={styles.choices} role="radiogroup" aria-label="The copy that should win">
        {loadable.map((copy) => (
          <li key={copy.path}>
            <button
              type="button"
              role="radio"
              aria-checked={winner === copy.path}
              className={styles.choice}
              data-on={winner === copy.path ? '' : undefined}
              onClick={() => setWinner(copy.path)}
            >
              <span className={styles.choiceDot} />
              <code className={kit.mono}>{shortPath(copy.path, home)}</code>
              <span className={styles.choiceNote}>
                {copy.readBy.length === 0
                  ? 'Read by nobody'
                  : `Read by ${copy.readBy
                      .map((id) => columns.find((one) => one.id === id)?.label ?? id)
                      .join(', ')}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {hollow.length > 0 && (
        <label className={styles.hollowLine}>
          {/* A checkbox for the same reason the import candidates are: this
              is part of a plan being composed, not a setting taking effect. */}
          <Checkbox
            checked={cleanHollow}
            aria-label="Also remove the empty copies"
            onCheckedChange={(next) => setCleanHollow(next === true)}
          />
          Also remove {hollow.length} empty {hollow.length === 1 ? 'copy' : 'copies'} of this name
        </label>
      )}
    </Dialog>
  )
}

/** A skill written here, delivered like any other install: previewed first. */
export const AuthorDialog = ({
  columns,
  onClose,
  onPlan,
}: {
  columns: readonly LibraryColumn[]
  onClose: () => void
  onPlan: (title: string, intents: readonly LibraryIntent[]) => void
}) => {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [targets, setTargets] = useState<ReadonlySet<RuntimeId>>(new Set())

  const slug = name.trim().toLowerCase().replace(/\s+/g, '-')
  const validName = /^[a-z0-9][a-z0-9._-]*$/.test(slug)
  const ready = validName && description.trim() !== '' && body.trim() !== '' && targets.size > 0

  const go = () => {
    const content = `---\nname: ${slug}\ndescription: ${description.trim()}\n---\n\n${body.trim()}\n`
    onPlan(`Install ${slug}`, [
      { kind: 'authorSkill', name: slug, content, targetRuntimes: [...targets] },
    ])
  }

  return (
    <Dialog
      title="New skill"
      icon={<PlusIcon size={16} />}
      /*
       * `xl` and a six-row body, so the form fits without the dialog
       * scrolling. It is not only about room: the first field is autofocused,
       * and a body that overflows is scrolled by that focus while the surface
       * is still animating open — which left the dialog showing an unlabelled
       * box with "Name" already clipped off the top. (The `scroll-margin` on
       * these controls is the other half, and the half that matters when a
       * short window makes it scroll anyway.)
       */
      size="xl"
      onClose={onClose}
      footer={
        <>
          <Btn variant="primary" disabled={!ready} onClick={go}>
            Preview the install
          </Btn>
          <Btn onClick={onClose}>Cancel</Btn>
        </>
      }
    >
      <div className={styles.form}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Name</span>
          <Input
            value={name}
            placeholder="release-notes"
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
          {name.trim() !== '' && !validName && (
            <span className={styles.fieldNote}>
              Letters, digits, dots and dashes — it becomes a directory name.
            </span>
          )}
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Description</span>
          <Input
            value={description}
            placeholder="When should an agent reach for this?"
            onChange={(event) => setDescription(event.target.value)}
          />
          <span className={styles.fieldNote}>
            Every agent carries this line on every turn — it is how the skill gets chosen, and what
            it costs.
          </span>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Instructions</span>
          <textarea
            className={styles.textarea}
            value={body}
            rows={6}
            placeholder="What the agent should do when this skill fires."
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Install for</span>
          {/* The same switcher the import pickers use, in its many-valued
              form. It was a row of the same invisible pills — and here the
              stakes are higher, because with none of them pressed the confirm
              button is disabled and nothing on screen says which of the four
              unstyled words is the thing to press. */}
          <ToggleGroup
            type="multiple"
            value={[...targets]}
            aria-label="Install for"
            className={`${SWITCH_TRACK} w-fit`}
            onValueChange={(next) => setTargets(new Set(next as RuntimeId[]))}
          >
            {columns.map((column) => (
              <ToggleGroupItem key={column.id} value={column.id} className={SWITCH_ITEM}>
                {column.info && <RuntimeMark runtime={column.info} size={13} />}
                {column.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>
    </Dialog>
  )
}

/** One audit entry as the history shows it. */
interface HistoryRow {
  readonly at: number
  readonly op: string
  readonly name: string
  readonly path: string
  readonly status: string
  readonly backupPath?: string
  readonly detail?: string
  readonly runtime: string
}

const HISTORY_VERB: Readonly<Record<string, string>> = {
  'skill/create': 'Installed',
  'skill/update': 'Updated',
  'skill/replace': 'Replaced a copy of',
  'skill/remove': 'Removed a copy of',
  'mcp/create': 'Added',
  'mcp/update': 'Updated',
  'mcp/replace': 'Replaced',
  'mcp/remove': 'Removed',
}

/** The same verbs in the infinitive, because a failure is "failed to do". */
const HISTORY_TRY: Readonly<Record<string, string>> = {
  'skill/create': 'install',
  'skill/update': 'update',
  'skill/replace': 'replace a copy of',
  'skill/remove': 'remove a copy of',
  'mcp/create': 'add',
  'mcp/update': 'update',
  'mcp/replace': 'replace',
  'mcp/remove': 'remove',
}

/**
 * What changed from here — the audit log's library entries, on the page that
 * made them.
 *
 * The point is not nostalgia: every replace and remove filed a backup, and a
 * record nobody can act on makes the backups decoration. Each row that kept
 * one offers Restore, which is just another previewed plan — the backup
 * becomes the copy again, and whatever it displaces is filed in turn.
 */
export const LibraryHistory = ({
  refreshedAt,
  home,
  onFlow,
}: {
  /** Changes when the page rescans, so the history refetches with it. */
  refreshedAt: number
  /** The host's home, so every path here prints the way it is written. */
  home?: string | undefined
  onFlow: (flow: LibraryFlow) => void
}) => {
  const store = useStore()
  const [rows, setRows] = useState<readonly HistoryRow[] | null>(null)
  const [all, setAll] = useState(false)

  useEffect(() => {
    let cancelled = false
    store.transport
      .request('audit/query', { sinceDays: 90 })
      .then((entries) => {
        if (cancelled) return
        // The log appends, so it arrives oldest-first; a history is read the
        // other way round — what just happened on top, the past behind
        // "Show all".
        setRows(
          entries
            .filter((entry) => entry.kind === 'library/write')
            .sort((a, b) => b.at - a.at)
            .map((entry) => ({
              at: entry.at,
              op: entry.op ?? '',
              name: entry.name ?? '',
              path: entry.path ?? '',
              status: entry.status ?? '',
              runtime: String(entry.runtime),
              ...(entry.backupPath !== undefined ? { backupPath: entry.backupPath } : {}),
              ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
            })),
        )
      })
      .catch(() => setRows([]))
    return () => {
      cancelled = true
    }
  }, [store, refreshedAt])

  if (rows === null || rows.length === 0) return null
  const shown = all ? rows : rows.slice(0, 6)

  return (
    <section className={styles.history} aria-label="Changes made from here">
      <h3 className={styles.historyHead}>Changes made from here</h3>
      <ul className={styles.historyRows}>
        {shown.map((row, index) => (
          <li key={`${row.at}-${index}`} className={styles.historyRow} data-status={row.status}>
            <span className={styles.historyWhen}>
              {new Date(row.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
            <span className={styles.historyWhat}>
              {row.status === 'failed'
                ? `Failed to ${HISTORY_TRY[row.op] ?? row.op} ${row.name}${row.detail ? ` — ${row.detail}` : ''}`
                : `${HISTORY_VERB[row.op] ?? row.op} ${row.name}`}
              <code className={`${kit.mono} ${styles.historyPath}`} title={row.path}>
                {shortPath(row.path, home)}
              </code>
            </span>
            {row.backupPath !== undefined && row.status === 'done' && (
              <Btn
                small
                title={`Restore what this change filed at ${row.backupPath}`}
                onClick={() =>
                  onFlow({
                    type: 'plan',
                    title: `Restore ${row.name}`,
                    intents: [
                      {
                        kind: 'restoreCopy',
                        name: row.name,
                        backupPath: row.backupPath ?? '',
                        targetPath: row.path,
                      },
                    ],
                  })
                }
              >
                Restore…
              </Btn>
            )}
          </li>
        ))}
      </ul>
      {rows.length > shown.length && (
        <Btn small onClick={() => setAll(true)}>
          Show all {rows.length}
        </Btn>
      )}
    </section>
  )
}

/**
 * The one dispatcher the page renders. Flows that gather input hand their
 * intents forward into the plan flow; the plan flow is the only one that
 * touches the host.
 */
export const LibraryFlows = ({
  flow,
  setFlow,
  library,
  columns,
  cwd,
  onApplied,
}: {
  flow: LibraryFlow | null
  setFlow: (next: LibraryFlow | null) => void
  library: Library | null
  columns: readonly LibraryColumn[]
  cwd?: string | undefined
  onApplied: () => void
}) => {
  const toPlan = useCallback(
    (title: string, intents: readonly LibraryIntent[]) => setFlow({ type: 'plan', title, intents }),
    [setFlow],
  )
  if (flow === null) return null
  if (flow.type === 'plan') {
    return (
      <PlanDialog
        title={flow.title}
        intents={flow.intents}
        columns={columns}
        cwd={cwd}
        home={library?.home}
        onClose={() => setFlow(null)}
        onApplied={onApplied}
      />
    )
  }
  if (flow.type === 'import') {
    if (library === null) return null
    return (
      <ImportDialog library={library} columns={columns} onClose={() => setFlow(null)} onPlan={toPlan} />
    )
  }
  if (flow.type === 'resolve') {
    return (
      <ResolveDialog
        entry={flow.entry}
        columns={columns}
        home={library?.home}
        onClose={() => setFlow(null)}
        onPlan={toPlan}
      />
    )
  }
  return <AuthorDialog columns={columns} onClose={() => setFlow(null)} onPlan={toPlan} />
}
