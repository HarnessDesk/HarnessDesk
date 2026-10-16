import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  isReachProblem,
  type LibraryDefinition,
  type LibraryEntry,
  type LibraryIntent,
  type LibraryUsage,
  type RuntimeId,
} from '@harnessdesk/protocol'

import { useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import {
  AlertIcon,
  CopyIcon,
  CrossIcon,
  DiffIcon,
  FileIcon,
  SlashIcon,
  TrashIcon,
} from './Icons'
import { Markdown } from './Markdown'
import {
  Badge,
  Banner,
  Button,
  CodeBlock,
  CodeText,
  DialogBody,
  DialogContent,
  DialogHead,
  DialogRoot,
  EmptyState,
  FormStack,
  IconTile,
  KeyValue,
  KeyValueRow,
  Note,
  SectionFooter,
  Segmented,
  Separator,
  Switch,
  Text,
} from '../design'
import { installSource, type LibraryColumn, type LibraryFlow } from './LibraryActions'
import { handOverToComposer } from '../lib/compose'
import { shortPath } from '../lib/paths'
import { REACH_SENTENCE } from '../lib/reach-states'
import { libraryRepository, libraryUpdateFor } from '../lib/library-updates'

/**
 * One skill, opened.
 *
 * This is the half of the page that did not exist. The library could tell you
 * a skill sat in four directories, that two of them disagreed, and that it
 * cost ninety-six tokens a turn — and it could not show you a single word the
 * skill actually said. A page about instruction bundles that cannot display
 * an instruction bundle is a page about directories.
 *
 * Claude's skill detail is the shape to take: a file tree beside the rendered
 * `SKILL.md`, with the frontmatter description called out above it. Codex's
 * is the same document without the tree. Both are *readable* — you open one
 * to find out what the thing does, and you leave knowing.
 *
 * What this adds to theirs is the evidence panel, which is everything the
 * matrix used to be the only home for: which agents load it and on what
 * basis, every copy on disk with its path, what it costs, whether it has ever
 * fired. Those facts were the whole page; here they are the sidebar of the
 * thing they are facts *about*, which is where a fact belongs.
 *
 * The verbs are unchanged and deliberately so. Every one still opens the same
 * previewed plan the matrix opened — install, resolve, remove — because the
 * reading discipline (an action opens a plan, the plan shows diffs, only a
 * confirmation writes) is the property that makes this app safe to point at
 * another program's configuration directory. A prettier front door is not a
 * reason to start writing without a diff.
 */

/**
 * The frontmatter block, split off the body.
 *
 * The definition travels whole — the frontmatter is what the agent reads to
 * decide whether to fire the skill, so hiding it would hide the mechanism
 * this app exists to make legible. But `marked` renders a leading `---` as a
 * horizontal rule and then sets the YAML as a paragraph of run-together
 * prose, which is worse than either showing it or not. So it is lifted out
 * and shown as itself.
 */
const splitFrontmatter = (text: string): { front: string | null; body: string } => {
  if (!text.startsWith('---')) return { front: null, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { front: null, body: text }
  const after = text.indexOf('\n', end + 1)
  return {
    front: text.slice(3, end).trim(),
    body: after === -1 ? '' : text.slice(after + 1),
  }
}

/** Bytes, at the precision a person reading a file list actually wants. */
const size = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The bundle, as a list.
 *
 * A real tree — expandable folders, the way Claude draws it — buys nothing
 * here: nothing in this sheet opens a second file, so a control that folds
 * away paths would only be hiding the answer to "what is in this bundle".
 * The paths are shown whole, indented by depth, which reads as a tree and
 * stays honest about a bundle whose interesting file is three levels down.
 */
const BundleFiles = ({ definition }: { definition: LibraryDefinition }) => (
  <div className="flex flex-col gap-1">
    {definition.files.map((file) => {
      const depth = file.path.split('/').length - 1
      const leaf = file.path.slice(file.path.lastIndexOf('/') + 1)
      const parent = depth > 0 ? file.path.slice(0, file.path.lastIndexOf('/')) : null
      return (
        <div
          key={file.path}
          className="flex min-w-0 items-baseline gap-1.5"
          /* The tree's indent is where a line starts, not a box it draws. */
          style={{ marginInlineStart: `${Math.min(depth, 3) * 10}px` }}
        >
          <Text role="meta" truncate className="min-w-0 flex-1">
            {parent && <>{parent}/</>}
            {/* The entry file is the one an agent reads first; it stands at
                full ink while the files it points at stay a step back. */}
            <Text role="meta" ink={file.path === 'SKILL.md' ? 'primary' : 'secondary'}>
              {leaf}
            </Text>
          </Text>
          <Text role="meta" numeric className="shrink-0">{size(file.bytes)}</Text>
        </div>
      )
    })}
    {definition.moreFiles > 0 && (
      <Text as="p" role="meta" className="m-0">
        and {definition.moreFiles} more {definition.moreFiles === 1 ? 'file' : 'files'} not listed
      </Text>
    )}
  </div>
)

/**
 * A titled block in the evidence column.
 *
 * Its name is the group label's step (13px, secondary ink, sentence case).
 * The page grammar's `GroupLabel` is that step with a name of its own; this
 * adopts it when it lands.
 */
const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-1.5">
    <Text as="h3" role="muted" className="m-0">{label}</Text>
    {children}
  </section>
)

export const SkillSheet = ({
  entry,
  columns,
  usage,
  hosts,
  cwd,
  home,
  onFlow,
  onChanged,
  onClose,
}: {
  entry: LibraryEntry
  columns: readonly LibraryColumn[]
  usage: LibraryUsage | null
  hosts: { readonly skill: ReadonlySet<RuntimeId>; readonly mcp: ReadonlySet<RuntimeId> }
  cwd: string | undefined
  /** The host's home directory, so a path can be printed the way it is written. */
  home: string | undefined
  onFlow: (flow: LibraryFlow) => void
  /** Something changed in an agent; the page owes itself a fresh read. */
  onChanged: () => void
  onClose: () => void
}) => {
  const store = useStore()
  const surface = useRef<HTMLDivElement>(null)
  const [definition, setDefinition] = useState<LibraryDefinition | null>(null)
  const [reading, setReading] = useState(true)
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  const [copied, setCopied] = useState(false)
  /** The agent whose switch is mid-flight, so its row cannot be pressed twice. */
  const [busy, setBusy] = useState<RuntimeId | null>(null)
  /** True while an agent is being asked to re-read its directories. */
  const [rereading, setRereading] = useState(false)
  /**
   * What the last press produced, per agent: the ones that declined and why,
   * and the ones that really did re-read.
   *
   * Kept rather than reduced to one message, because a press can reach three
   * agents and get three different answers, and "it failed" for all of them
   * would be as wrong as the silence it replaced.
   */
  const [declined, setDeclined] = useState<readonly { runtime: RuntimeId; reason: string }[]>([])
  const [rereadDone, setRereadDone] = useState<ReadonlySet<RuntimeId>>(new Set())
  const [fetching, setFetching] = useState(false)
  const [fetchFailed, setFetchFailed] = useState<string | null>(null)
  const fetchGeneration = useRef(0)
  useEffect(() => {
    setFetching(false)
    setFetchFailed(null)
    return () => { fetchGeneration.current++ }
  }, [entry])
  const update = libraryUpdateFor(entry)
  const origins = [...new Map(entry.copies.flatMap(copy => copy.origin ? [[JSON.stringify(copy.origin), copy.origin] as const] : [])).values()]
  const reviewUpdate = async () => {
    if (fetching) return
    const ticket = fetchGeneration.current
    const current = () => ticket === fetchGeneration.current
    setFetching(true)
    setFetchFailed(null)
    try {
      const fetched = new Map<string, Extract<LibraryIntent, { kind: 'updateSkill' }>['origin']>()
      const intents: LibraryIntent[] = []
      for (const one of entry.update ?? []) {
        if (one.status !== 'behind') continue
        const { url, ref, path } = one.origin
        const key = JSON.stringify([url, ref, path])
        let origin = fetched.get(key)
        if (!origin) {
          const answer = await store.transport.request('library/source/fetch', { url, ref, path })
          if (!current()) return
          const refused = answer.refused.find(folder => folder.dir === path)
          const skill = answer.skills.find(skill => skill.dir === path)
          if (refused || !skill) throw new Error(refused?.reason ?? `No skill was found at ${path || 'the repository root'}.`)
          origin = { url, ref, commit: answer.commit, path: skill.dir, bundle: skill.bundle }
          fetched.set(key, origin)
        }
        intents.push({ kind: 'updateSkill', name: entry.name, targetRuntime: one.runtime, origin })
      }
      if (current() && intents.length) onFlow({ type: 'plan', title: `Update ${entry.name}`, intents })
    } catch (error) {
      if (current()) setFetchFailed(error instanceof Error ? error.message : String(error))
    } finally {
      if (current()) setFetching(false)
    }
  }

  /**
   * The agents holding a copy they have not read back yet — the state of the
   * world one second after this sheet installs something.
   */
  const staleIn = entry.reach.filter((one) => one.state === 'stale')

  const canToggleReach = (reach: LibraryEntry['reach'][number]): boolean =>
    entry.kind === 'skill' &&
    reach.basis === 'reported' &&
    reach.toggleable !== false &&
    (reach.state === 'reaches' || reach.state === 'off')
  const reachFactCounts = new Map<string, { count: number; warning: boolean }>()
  for (const reach of entry.reach) {
    if (canToggleReach(reach)) continue
    const sentence = REACH_SENTENCE[reach.state]
    const fact = reachFactCounts.get(sentence) ?? { count: 0, warning: false }
    fact.count += 1
    fact.warning ||= isReachProblem(reach.state)
    reachFactCounts.set(sentence, fact)
  }
  const repeatedReachFacts = [...reachFactCounts].filter(([, fact]) => fact.count > 1)
  const repeatedReachSentences = new Set(repeatedReachFacts.map(([sentence]) => sentence))
  const groupedWhy = new Map<string, string[]>()
  for (const reach of entry.reach) {
    if (reach.note) {
      const label = columns.find((one) => one.id === reach.runtime)?.label ?? reach.runtime
      groupedWhy.set(reach.note, [...(groupedWhy.get(reach.note) ?? []), label])
    }
  }

  /**
   * Agents that read this definition and refused it, with their reason.
   *
   * Worth a word beside the install offers: copying a definition one agent
   * has already rejected into three more is a plausible next click and
   * almost never what anybody wants. Not a block — loader rules differ, and
   * this page does not know another agent's — but the refusal is a fact the
   * person should have in front of them before they spread the file.
   */
  const refusedBy = entry.reach.filter((one) => one.state === 'rejected')

  /**
   * Agents that re-read on this sheet's asking and *still* do not list it.
   *
   * The re-read happened, so "it has not looked since" is no longer a
   * possible explanation; what is left is a definition this agent will not
   * accept — a frontmatter it cannot parse, a name it rejects. Saying so is
   * the difference between a button somebody presses twice and a finding.
   */
  const rereadAndStillStale = staleIn.filter((one) => rereadDone.has(one.runtime))

  /**
   * Ask them to look again.
   *
   * The page could only *report* this before: "installed, and the agent has
   * not read its directories since" is true, useful, and leaves the reader
   * to work out that the fix is to restart an agent — which they would then
   * do somewhere else in the app, if they guessed. The desk is already
   * holding the process; the honest thing is to offer the step rather than
   * describe it.
   *
   * `runtime/refreshCatalog` restarts a runtime **only when it is idle**, so
   * a turn in flight is never interrupted by a housekeeping press — and the
   * host now says which of those two happened. It has to: the call resolves
   * either way, and reading "it resolved" as "it re-read" is exactly how this
   * button used to report a refusal as a success.
   */
  const reread = async (): Promise<void> => {
    setRereading(true)
    setDeclined([])
    const refused: { runtime: RuntimeId; reason: string }[] = []
    const done = new Set<RuntimeId>()
    for (const one of staleIn) {
      try {
        const answer = await store.transport.request('runtime/refreshCatalog', {
          runtime: one.runtime,
        })
        if (answer.refreshed) done.add(one.runtime)
        else refused.push({ runtime: one.runtime, reason: answer.reason ?? 'It did not re-read.' })
      } catch (error) {
        // One agent's failure never stops the others: the loop is per agent
        // for the same reason apply is per op.
        refused.push({
          runtime: one.runtime,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    setDeclined(refused)
    setRereadDone(done)
    setRereading(false)
    // Only when something actually changed. A re-read of nothing does not
    // owe the page a rescan, and asking for one would hide the refusal
    // behind a flash of the same numbers.
    if (done.size > 0) onChanged()
  }

  const source = installSource(entry)
  const digests = new Set(entry.copies.filter((one) => !one.hollow).map((one) => one.digest))
  const fired = usage?.skills[entry.name]

  /**
   * Read from the copy an install would read from — the loadable one some
   * agent actually loads, preferring it over a stranded copy. Showing a
   * different copy's text from the one the verbs would act on is the kind of
   * quiet substitution that makes a preview untrustworthy.
   */
  useEffect(() => {
    let live = true
    setReading(true)
    setDefinition(null)
    if (source === null) {
      setReading(false)
      return
    }
    void store.transport
      .request('library/definition', {
        kind: entry.kind,
        name: entry.name,
        path: source.path,
        ...(cwd !== undefined ? { cwd } : {}),
      })
      .then((answer) => {
        if (!live) return
        // Shape-checked rather than cast. The host answers null for every
        // ordinary miss, but this crossed a socket, and a renderer that
        // takes `answer.text` on faith blanks the whole page when it is
        // anything else. The sheet already has a good sentence for a
        // definition it cannot read; a malformed answer is one of those.
        const one = answer as Partial<LibraryDefinition> | null
        setDefinition(
          one && typeof one.text === 'string'
            ? {
                name: entry.name,
                kind: entry.kind,
                path: typeof one.path === 'string' ? one.path : source.path,
                text: one.text,
                truncated: one.truncated === true,
                files: Array.isArray(one.files) ? one.files : [],
                moreFiles: typeof one.moreFiles === 'number' ? one.moreFiles : 0,
              }
            : null,
        )
      })
      .catch(() => {
        if (live) setDefinition(null)
      })
      .finally(() => {
        if (live) setReading(false)
      })
    return () => {
      live = false
    }
  }, [store, entry.kind, entry.name, source?.path, cwd])

  const { front, body } = useMemo(
    () => (definition ? splitFrontmatter(definition.text) : { front: null, body: '' }),
    [definition],
  )

  /**
   * Throw one agent's switch.
   *
   * The row is disabled while the call is in flight rather than flipping
   * optimistically: this writes into another program's settings, and a
   * switch that snaps to the new position and then quietly snaps back is
   * how a person comes to believe they turned something off when they did
   * not. The store raises the failure as a notice; the page re-reads either
   * way, so what the row shows afterwards is what the agent actually says.
   */
  const flip = useCallback(
    async (runtime: RuntimeId, reportedPath: string | undefined, next: boolean) => {
      setBusy(runtime)
      try {
        /*
         * The path the *agent* reported, never the library's own copy path.
         *
         * They look interchangeable and are not: a copy's path is the bundle
         * directory found on disk, and Codex keys the same skill by its
         * `SKILL.md`. Sent the directory, Codex accepts the write, records a
         * `[[skills.config]]` entry keyed on a path it never matches, leaves
         * the skill on — and the switch springs back with no error anywhere.
         * Measured all three ways; only the agent's own path and the bare
         * name work. Null falls back to the name, which is what an agent that
         * reported no path still agrees with us about.
         */
        await store.setSkillEnabled({ name: entry.name, path: reportedPath ?? null }, next, runtime)
      } catch {
        // Already reported as a notice by the store; the re-read below is
        // what corrects the row.
      } finally {
        setBusy(null)
        onChanged()
      }
    },
    [store, entry.name, onChanged],
  )

  const copy = useCallback(() => {
    if (!definition) return
    void navigator.clipboard.writeText(definition.text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }, [definition])

  /**
   * The agents this could be brought to — the same arithmetic the matrix
   * row used, kept identical rather than re-derived: an entry whose copies
   * disagree offers no install, because *which* content would travel is the
   * open question and answering it silently is the bug that flow exists to
   * avoid.
   */
  const installable = columns.filter((column, index) => {
    if (entry.kind === 'skill' && digests.size > 1) return false
    const state = entry.reach[index]?.state
    if (state !== 'absent' && state !== 'unscanned') return false
    if (entry.kind === 'skill') return source !== null && hosts.skill.has(column.id)
    return entry.copies.length > 0 && hosts.mcp.has(column.id)
  })

  const mcpSource = entry.copies.find((one) => one.readBy.length > 0) ?? entry.copies[0]
  const hollowCopies = entry.copies.filter((one) => one.hollow && !one.readOnly)

  /** An agent's column label, or its id when the column is gone. */
  const labelOf = (runtime: RuntimeId): string => columns.find((one) => one.id === runtime)?.label ?? runtime

  return (
    <DialogRoot open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        ref={surface}
        data-slot="skill-sheet"
        bleed
        /* Nothing here is typed into, so the surface takes the focus, as a
           Dialog without a field does: Escape reaches it, a reader lands
           inside, and no ring is drawn on Close for a keyboard opening. */
        initialFocus={() => surface.current}
        showCloseButton={false}
        className="flex h-[min(84vh,760px)] w-[min(1080px,94vw)] flex-col overflow-hidden"
      >
        {/* --- the head: what this is ---------------------------------- */}
        <DialogHead
          title={entry.title ?? entry.name}
          aside={<Badge variant="secondary">{entry.kind === 'skill' ? 'Skill' : 'MCP server'}</Badge>}
        >
          <Text role="meta">
            <CodeText as="code">{entry.kind === 'skill' ? `/${entry.name}` : entry.name}</CodeText>
          </Text>
        </DialogHead>

        {/* --- the body: the document, and the evidence ----------------- */}
        {/*
         * Wide: two columns, each scrolling in its own lane, so the evidence
         * stays put while a long definition is read past.
         *
         * Narrow: one column and **one** scroller. Stacking the two lanes
         * without also merging the scrollers gives a 400px window onto the
         * document sitting above a second 300px window onto the facts, and
         * the reader has to find and work two of them — which is what this
         * did before the narrow case was looked at.
         */}
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_auto_300px] md:overflow-hidden">
          {/* The definition. The largest thing in the sheet, because it is
              the thing the sheet is about. */}
          <div className="flex min-w-0 flex-col md:min-h-0">
            <DialogBody layout="reading">
              <div className="mb-4 flex items-center justify-between gap-2">
                <Segmented
                  label="How to show the definition"
                  value={view}
                  options={[
                    { value: 'rendered', label: 'Rendered' },
                    { value: 'source', label: 'Source' },
                  ]}
                  onChange={setView}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={definition === null}
                  onClick={copy}
                  title="Copy the definition exactly as it sits on disk"
                >
                  <CopyIcon size={13} />
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              {entry.description && <div className="mb-4"><Markdown text={entry.description} document /></div>}
              {reading ? (
                <EmptyState variant="inline" title="Reading the definition…" />
              ) : definition === null ? (
                /* Never a blank pane. The three reasons a definition cannot
                   be read are all real states of a real machine, and each
                   one is already named elsewhere on the page — so this says
                   which, rather than showing nothing and letting it read as
                   a failure of the app. */
                <EmptyState
                  tight
                  icon={<AlertIcon />}
                  title="No definition to read"
                  description={
                    entry.copies.every((one) => one.hollow)
                      ? 'Every copy of this is an empty directory — there is no definition on disk to read.'
                      : 'This definition could not be read. It may have moved or been removed since the last scan; Rescan will say.'
                  }
                />
              ) : view === 'source' ? (
                /* The whole file, in the code face at the muted step, which
                   the lane already scrolls: a plate that scrolled as well
                   would be a second, smaller window onto the same reading. */
                <Text as="div" role="muted">
                  <CodeText as="pre" className="m-0 whitespace-pre-wrap">{definition.text}</CodeText>
                </Text>
              ) : (
                <>
                  {front !== null && (
                    <div className="mb-4 flex flex-col gap-1.5">
                      <Text
                        as="p"
                        role="meta"
                        className="m-0"
                        title="What the runtime reads every turn to decide whether to fire this skill — the line the catalogue estimate prices."
                      >
                        Frontmatter
                      </Text>
                      <CodeBlock output={front} />
                    </div>
                  )}
                  <Markdown text={body} document />
                </>
              )}
              {definition?.truncated && (
                <Text as="p" role="meta" className="mt-3 mb-0">
                  This definition is longer than the sheet reads; what is shown stops short of the
                  end of the file.
                </Text>
              )}
            </DialogBody>
          </div>

          <Separator orientation="vertical" className="hidden md:block" />
          <Separator className="md:hidden" />

          {/* The evidence. Everything the matrix knew, about this one thing. */}
          <DialogBody layout="reading" className="flex min-w-0 flex-col gap-4">
            {update?.status === 'behind' && <Banner tone="info" title="Update available"
              actions={<Button variant="outline" size="sm" disabled={fetching} onClick={() => void reviewUpdate()}>{fetching ? 'Fetching…' : 'Review update…'}</Button>}>
              {fetchFailed ?? `${update.origin.commit.slice(0, 7)} → ${update.latest?.slice(0, 7) ?? ''}`}
            </Banner>}
            {update?.status === 'gone' && <Banner tone="warning" title="Source branch is gone">
              The branch {update.origin.ref} no longer exists in {libraryRepository(update.origin)}.
            </Banner>}
            {update?.status === 'unreachable' && <Text role="meta">Could not check: {update.reason}</Text>}
            {origins.length > 0 && <Fact label="Where it came from">
              {origins.map(origin => <div key={JSON.stringify(origin)}>
                <CodeText as="code">{libraryRepository(origin)}</CodeText>
                <div><Text role="meta">{origin.path || 'Repository root'} · {origin.ref}, pinned at {origin.commit.slice(0, 7)}</Text></div>
              </div>)}
            </Fact>}
            <Fact label="Which runtimes load it">
              <FormStack>
                <div role="list" className="flex flex-col gap-1.5">
                {entry.reach.map((reach, index) => {
                  const column = columns[index]
                  const problem = isReachProblem(reach.state)
                  /*
                   * The switch appears only where it would work.
                   *
                   * Three conditions, and the third was learned the hard way.
                   * The agent has to *have* the skill (loaded, or
                   * loaded-and-off) and to have *reported* it, which is the
                   * only way its on/off is knowable at all. And it has to
                   * accept the write: measured across four agents, only Codex
                   * does. Claude Code and Cursor answer over ACP, where a
                   * skill is a command the agent declares for the session and
                   * there is no client-side switch — drawn one anyway, they
                   * threw "This runtime does not let a client toggle skills"
                   * and the control sprang back.
                   *
                   * A switch the host would refuse is worse than no switch:
                   * the row already has a true sentence to show instead.
                   */
                  const switchable = canToggleReach(reach)
                  return (
                    <div key={reach.runtime} role="listitem" className="flex min-w-0 items-baseline gap-2">
                      <span className="flex flex-none translate-y-0.5 items-center gap-1.5">
                        {column?.info ? (
                          <IconTile aria-hidden="true" size="xs" shape="face">
                            <RuntimeMark runtime={column.info} size={12} />
                          </IconTile>
                        ) : (
                          <span className="inline-block w-3" />
                        )}
                        <Text role="meta" ink="primary">{column?.label ?? reach.runtime}</Text>
                      </span>
                      {switchable ? (
                        <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
                          {/* On is the resting, working state a switchable
                              reach is meant to be in — health takes no
                              tone, so it reads untoned like Off. */}
                          <Text role="meta">{reach.state === 'reaches' ? 'On' : 'Off'}</Text>
                          <Switch
                            checked={reach.state === 'reaches'}
                            disabled={busy === reach.runtime}
                            aria-label={`${entry.name} in ${column?.label ?? reach.runtime}`}
                            onCheckedChange={(next) =>
                              void flip(reach.runtime, reach.reportedPath, next)
                            }
                          />
                        </span>
                      ) : repeatedReachSentences.has(REACH_SENTENCE[reach.state]) ? null : (
                        <Text
                          role="meta"
                          align="end"
                          {...(problem ? { tone: 'warning' as const } : {})}
                          /* `text-balance`: these sentences are longer than
                             the rail is wide and wrapped with one orphaned
                             word — "Installed where this agent does not /
                             look" — on the two states most rows are in. */
                          className="min-w-0 flex-1 text-balance"
                        >
                          {REACH_SENTENCE[reach.state]}
                        </Text>
                      )}
                    </div>
                  )
                })}
                </div>
                {repeatedReachFacts.map(([sentence, fact]) => (
                  <Note key={sentence} ink="muted" {...(fact.warning ? { tone: 'warn' as const } : {})}>
                    {sentence === REACH_SENTENCE.unscanned
                      ? 'Installed where these runtimes do not look'
                      : sentence}
                  </Note>
                ))}
              </FormStack>
              {staleIn.length > 0 && (
                <Text as="p" role="meta" ink="secondary" className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  <span className="min-w-0">
                    {staleIn.length === 1
                      ? `${columns.find((one) => one.id === staleIn[0]?.runtime)?.label ?? 'One runtime'} lists the skills it read when it started.`
                      : `${staleIn.length} runtimes list the skills they read when they started.`}
                  </span>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={rereading}
                    onClick={() => void reread()}
                  >
                    {rereading ? 'Asking…' : 'Have it look again'}
                  </Button>
                </Text>
              )}
              {/* Named, one line each. A press can reach three agents and get
                  three different answers back — "it failed" for all of them
                  would be as wrong as the silence this replaced. */}
              {declined.map((one) => (
                <Text as="p" role="meta" tone="warning" key={one.runtime} className="m-0">
                  {labelOf(one.runtime)}
                  {' — '}
                  {one.reason}
                </Text>
              ))}
              {/* It re-read and still does not list it, so the explanation
                  the line above offers is spent. What is left is a definition
                  this agent will not take. */}
              {rereadAndStillStale.length > 0 && (
                <Text as="p" role="meta" tone="warning" className="m-0">
                  {rereadAndStillStale.length === 1
                    ? `${columns.find((one) => one.id === rereadAndStillStale[0]?.runtime)?.label ?? 'It'} re-read and still does not list it — the definition may be one it will not accept.`
                    : `${rereadAndStillStale.length} of them re-read and still do not list it — the definition may be one they will not accept.`}
                </Text>
              )}
              {/* The basis, once, rather than on every row. It is the same
                  answer for most machines and repeating it four times turns
                  a caveat into wallpaper. */}
              {entry.reach.some((one) => one.basis === 'scanned') && (
                <Text as="p" role="meta" className="m-0">
                  {entry.reach.every((one) => one.basis === 'scanned')
                    ? 'Read from disk against this build’s table of where each runtime looks — the runtimes themselves were not asked.'
                    : 'Some rows are what the runtime itself reported; the rest are read from disk.'}
                </Text>
              )}
            </Fact>

            {groupedWhy.size > 0 && (
              <Fact label="Why">
                <div role="list" className="flex flex-col gap-1">
                  {[...groupedWhy].map(([note, agents]) => (
                    <Text as="p" role="meta" ink="secondary" key={note} className="m-0">
                      <Text role="meta" ink="primary">{agents.join(', ')}</Text>
                      {' — '}
                      {note}
                    </Text>
                  ))}
                </div>
              </Fact>
            )}

            <Separator />

            <Fact
              label={entry.copies.length === 1 ? 'One copy on disk' : `${entry.copies.length} copies on disk`}
            >
              <div role="list" className="flex flex-col gap-2">
                {entry.copies.map((one) => (
                  <div key={one.path} role="listitem" className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex min-w-0 items-start gap-1">
                      {/* A folder's name, so the interface face. `anywhere`,
                          not `break-all`: a path only breaks when it has to,
                          so `/home/u/.claude/skills/…` keeps its segments
                          instead of being cut mid-word at the column edge. */}
                      <Text role="meta" ink="primary" className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                        {shortPath(one.path, home)}
                      </Text>
                      {!one.readOnly && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="-mt-0.5 flex-none"
                          aria-label={
                            entry.kind === 'skill'
                              ? `Remove the copy at ${one.path}`
                              : `Remove ${entry.name} from ${one.path}`
                          }
                          title="Remove this — previewed first, backed up before it goes"
                          onClick={() =>
                            onFlow({
                              type: 'plan',
                              title:
                                entry.kind === 'skill'
                                  ? `Remove a copy of ${entry.name}`
                                  : `Remove ${entry.name}`,
                              intents: [
                                entry.kind === 'skill'
                                  ? { kind: 'removeCopy', name: entry.name, path: one.path }
                                  : { kind: 'removeMcp', name: entry.name, path: one.path },
                              ],
                            })
                          }
                        >
                          <TrashIcon size={12} />
                        </Button>
                      )}
                    </div>
                    <Text role="meta">
                      {one.hollow
                        ? 'No definition inside — the name lists and nothing loads.'
                        : one.readBy.length === 0
                          ? entry.kind === 'mcp'
                            ? 'No runtime reads this file.'
                            : 'No runtime reads this directory.'
                          : `Read by ${one.readBy.map(labelOf).join(', ')}.`}
                      {one.readOnly && ' Shipped by the runtime.'}
                    </Text>
                  </div>
                ))}
              </div>
            </Fact>

            {entry.kind === 'skill' && definition !== null && definition.files.length > 0 && (
              <Fact
                label={
                  definition.files.length === 1
                    ? 'One file'
                    : `${definition.files.length} files in the bundle`
                }
              >
                <BundleFiles definition={definition} />
              </Fact>
            )}

            {entry.kind === 'skill' && (
              <Fact label="What it costs, and whether it earns it">
                <KeyValue variant="panel" className="m-0">
                  <KeyValueRow variant="panel" numeric label="Every turn">
                    <span title="Name and description at ≈3.6 characters per token — the catalogue line a runtime carries for every skill it loads, fired or not.">
                      {entry.catalogTokens ? `≈${entry.catalogTokens} tok` : '—'}
                    </span>
                  </KeyValueRow>
                  {usage !== null && (
                    <KeyValueRow variant="panel" numeric label="Fired here">
                      {fired
                        ? `${fired.activations}× in ${fired.sessions} ${
                            fired.sessions === 1 ? 'conversation' : 'conversations'
                          }`
                        : 'never'}
                    </KeyValueRow>
                  )}
                  {usage !== null && fired && fired.lastAt > 0 && (
                    <KeyValueRow variant="panel" numeric label="Last">
                      {new Date(fired.lastAt).toLocaleDateString()}
                    </KeyValueRow>
                  )}
                </KeyValue>
                {usage !== null && (
                  <Text as="p" role="meta" className="m-0">
                    Counted in the {usage.sessionsScanned} conversations this desk stores. What ran
                    elsewhere is not counted.
                  </Text>
                )}
              </Fact>
            )}
          </DialogBody>
        </div>

        {/* --- the verbs ------------------------------------------------ */}
        <SectionFooter className="flex-wrap">
          {/*
           * The card teaches `/name`; this is where that becomes a thing you
           * did. Same hand-over the per-agent skills page uses, so there is
           * one way into the composer and not two that drift. The Library is
           * a page, not the conversation, so the composer ignores a bare event
           * sent from here: go back to the work first, then hand over until a
           * composer takes it, and say so when none does.
           */}
          {entry.kind === 'skill' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onClose()
                store.returnToWork()
                void handOverToComposer({ text: `/${entry.name} ` }).then((received) => {
                  if (!received) store.notice('warning', 'The message box did not take it — click into the conversation and try again.')
                })
              }}
            >
              <SlashIcon size={13} />
              Use in composer
            </Button>
          )}
          {entry.kind === 'skill' && digests.size > 1 && (
            <Button variant="outline" size="sm" onClick={() => onFlow({ type: 'resolve', entry })}>
              <DiffIcon size={13} />
              Resolve copies…
            </Button>
          )}
          {entry.kind === 'skill' && hollowCopies.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                onFlow({
                  type: 'plan',
                  title: `Clean up empty copies of ${entry.name}`,
                  intents: hollowCopies.map((one) => ({
                    kind: 'removeCopy' as const,
                    name: entry.name,
                    path: one.path,
                  })),
                })
              }
            >
              <CrossIcon size={13} />
              Clean up empty {hollowCopies.length === 1 ? 'copy' : 'copies'}
            </Button>
          )}

          <span className="flex-1" />

          {/*
           * One button per agent reads fine at three and becomes a keyboard
           * row at ten, so past three the offer collapses into one previewed
           * plan with an op per agent. The preview still names every target
           * and apply is still per-op, so a refusal for one never blocks the
           * rest — the matrix's rule, kept.
           */}
          {installable.length > 3 ? (
            <Button
              size="sm"
              onClick={() =>
                onFlow({
                  type: 'plan',
                  title: `${entry.kind === 'skill' ? 'Install' : 'Add'} ${entry.name} for ${
                    installable.length
                  } runtimes`,
                  intents: installable.map((column) =>
                    entry.kind === 'skill'
                      ? {
                          kind: 'installSkill' as const,
                          name: entry.name,
                          sourcePath: source?.path ?? '',
                          targetRuntime: column.id,
                        }
                      : {
                          kind: 'installMcp' as const,
                          name: entry.name,
                          sourcePath: mcpSource?.path ?? '',
                          targetRuntime: column.id,
                        },
                  ),
                })
              }
            >
              {entry.kind === 'skill' ? 'Install' : 'Add'} to all {installable.length} missing…
            </Button>
          ) : (
            installable.map((column) => (
              <Button
                key={column.id}
                variant={installable.length === 1 ? 'default' : 'outline'}
                size="sm"
                onClick={() =>
                  onFlow({
                    type: 'plan',
                    title: `${entry.kind === 'skill' ? 'Install' : 'Add'} ${entry.name} for ${column.label}`,
                    intents: [
                      entry.kind === 'skill'
                        ? {
                            kind: 'installSkill',
                            name: entry.name,
                            sourcePath: source?.path ?? '',
                            targetRuntime: column.id,
                          }
                        : {
                            kind: 'installMcp',
                            name: entry.name,
                            sourcePath: mcpSource?.path ?? '',
                            targetRuntime: column.id,
                          },
                    ],
                  })
                }
              >
                {column.info && <RuntimeMark runtime={column.info} size={13} />}
                {/* One verb per kind, everywhere. A skill is *installed* — it
                    is a directory of files that lands on disk — and a server
                    is *added*, because it is a line in a configuration file.
                    The matrix drawer said "Install to Cursor" and this button
                    said "Add to Cursor" about the identical act, two presses
                    apart on the same page. */}
                {entry.kind === 'skill' ? 'Install' : 'Add'} to {column.label}
              </Button>
            ))
          )}
          {refusedBy.length > 0 && installable.length > 0 && (
            <Text role="meta" tone="warning" className="flex items-center gap-1.5">
              <AlertIcon size={12} />
              {refusedBy.length === 1
                ? `${columns.find((one) => one.id === refusedBy[0]?.runtime)?.label ?? 'One runtime'} would not load this one.`
                : `${refusedBy.length} runtimes would not load this one.`}
            </Text>
          )}
          {installable.length === 0 && (
            <Text role="meta" className="flex items-center gap-1.5">
              <FileIcon size={12} />
              {entry.reach.every((one) => one.state === 'reaches')
                ? 'Every runtime already loads this.'
                : digests.size > 1
                  ? 'Resolve the copies before installing anywhere else.'
                  : 'Nowhere left to install this.'}
            </Text>
          )}
        </SectionFooter>
      </DialogContent>
    </DialogRoot>
  )
}
