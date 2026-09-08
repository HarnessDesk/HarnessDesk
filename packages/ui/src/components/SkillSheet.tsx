import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  isReachProblem,
  type LibraryDefinition,
  type LibraryEntry,
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
import { kit } from '../design/primitives/Kit'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  IconTile,
  Separator,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
} from '../design/ui'
import { installSource, type LibraryColumn, type LibraryFlow } from './LibraryActions'
import { shortPath } from '../lib/paths'
import { REACH_SENTENCE } from '../lib/reach-states'
import { monogramFor } from './SkillRow'

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
          className="flex min-w-0 items-baseline gap-1.5 text-xs"
          style={{ paddingLeft: `${Math.min(depth, 3) * 10}px` }}
        >
          <span className="min-w-0 flex-1 truncate">
            {parent && <span className="text-(--hd-muted-foreground)">{parent}/</span>}
            <span
              className={
                file.path === 'SKILL.md' ? 'font-medium' : 'text-(--hd-secondary-foreground)'
              }
            >
              {leaf}
            </span>
          </span>
          <span className="shrink-0 tabular-nums text-(--hd-muted-foreground)">{size(file.bytes)}</span>
        </div>
      )
    })}
    {definition.moreFiles > 0 && (
      <p className="m-0 text-xs text-(--hd-muted-foreground)">
        and {definition.moreFiles} more {definition.moreFiles === 1 ? 'file' : 'files'} not listed
      </p>
    )}
  </div>
)

/** A titled block in the evidence column. */
const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-1.5">
    <h3 className="m-0 text-xs font-medium text-(--hd-muted-foreground)">{label}</h3>
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

  /**
   * The agents holding a copy they have not read back yet — the state of the
   * world one second after this sheet installs something.
   */
  const staleIn = entry.reach.filter((one) => one.state === 'stale')

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

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        data-slot="skill-sheet"
        className="flex h-[min(84vh,760px)] w-[min(1080px,94vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        {/* --- the head: what this is ---------------------------------- */}
        <div className="flex items-start gap-3 border-b px-5 py-4">
          <IconTile size="lg" aria-hidden className="text-xs font-semibold">
            {monogramFor(entry.name)}
          </IconTile>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <DialogTitle className="truncate text-base leading-tight">
                {entry.title ?? entry.name}
              </DialogTitle>
              <Badge variant="secondary">{entry.kind === 'skill' ? 'Skill' : 'MCP server'}</Badge>
            </div>
            {/* The name as it is typed. Same reasoning as the card: the
                on-disk identity and the invocation are two different
                strings, and only showing the first leaves the second to
                guesswork. */}
            <code className={`${kit.mono} text-xs text-(--hd-muted-foreground)`}>
              {entry.kind === 'skill' ? `/${entry.name}` : entry.name}
            </code>
            {entry.description && (
              <DialogDescription className="mt-0.5 text-sm leading-relaxed text-(--hd-secondary-foreground)">
                {entry.description}
              </DialogDescription>
            )}
          </div>
        </div>

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
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[1fr_300px] md:overflow-hidden">
          {/* The definition. The largest thing in the sheet, because it is
              the thing the sheet is about. */}
          <div className="flex min-w-0 flex-col border-b md:min-h-0 md:border-r md:border-b-0">
            <div className="flex items-center justify-between gap-2 px-5 py-2">
              <ToggleGroup
                type="single"
                value={view}
                aria-label="How to show the definition"
                className="h-7 rounded-md bg-muted p-0.5"
                onValueChange={(next) => {
                  if (next === 'rendered' || next === 'source') setView(next)
                }}
              >
                <ToggleGroupItem
                  value="rendered"
                  className="h-full rounded-sm px-2 text-xs text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-xs"
                >
                  Rendered
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="source"
                  className="h-full rounded-sm px-2 text-xs text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-xs"
                >
                  Source
                </ToggleGroupItem>
              </ToggleGroup>
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

            <div className="px-5 pb-5 md:min-h-0 md:flex-1 md:overflow-y-auto">
              {reading ? (
                <p className="text-sm text-(--hd-muted-foreground)">Reading the definition…</p>
              ) : definition === null ? (
                /* Never a blank pane. The three reasons a definition cannot
                   be read are all real states of a real machine, and each
                   one is already named elsewhere on the page — so this says
                   which, rather than showing nothing and letting it read as
                   a failure of the app. */
                <p className="flex items-start gap-2 text-sm text-(--hd-secondary-foreground)">
                  <span className="mt-0.5 flex-none text-(--hd-warning-ink)">
                    <AlertIcon size={13} />
                  </span>
                  <span>
                    {entry.copies.every((one) => one.hollow)
                      ? 'Every copy of this is an empty directory — there is no definition on disk to read.'
                      : 'This definition could not be read. It may have moved or been removed since the last scan; Rescan will say.'}
                  </span>
                </p>
              ) : view === 'source' ? (
                <pre
                  className={`${kit.mono} m-0 text-xs leading-relaxed whitespace-pre-wrap text-(--hd-secondary-foreground)`}
                >
                  {definition.text}
                </pre>
              ) : (
                <>
                  {front !== null && (
                    <div className="mb-4 rounded-(--hd-radius) bg-(--hd-muted) px-3 py-2">
                      <p
                        className="m-0 mb-1 text-xs font-medium text-(--hd-muted-foreground)"
                        title="What the agent reads every turn to decide whether to fire this skill — the line the catalogue estimate prices."
                      >
                        Frontmatter
                      </p>
                      <pre
                        className={`${kit.mono} m-0 text-xs leading-relaxed whitespace-pre-wrap text-(--hd-secondary-foreground)`}
                      >
                        {front}
                      </pre>
                    </div>
                  )}
                  <Markdown text={body} document />
                </>
              )}
              {definition?.truncated && (
                <p className="mt-3 text-xs text-(--hd-muted-foreground)">
                  This definition is longer than the sheet reads; what is shown stops short of the
                  end of the file.
                </p>
              )}
            </div>
          </div>

          {/* The evidence. Everything the matrix knew, about this one thing. */}
          <aside className="flex min-w-0 flex-col gap-4 px-5 py-3 md:min-h-0 md:overflow-y-auto">
            <Fact label="Which agents load it">
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
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
                  const switchable =
                    entry.kind === 'skill' &&
                    reach.basis === 'reported' &&
                    reach.toggleable !== false &&
                    (reach.state === 'reaches' || reach.state === 'off')
                  return (
                    <li key={reach.runtime} className="flex min-w-0 items-baseline gap-2 text-xs">
                      <span className="flex flex-none translate-y-0.5 items-center gap-1.5">
                        {column?.info ? (
                          <RuntimeMark runtime={column.info} size={12} />
                        ) : (
                          <span className="inline-block size-3" />
                        )}
                        <span className="font-medium">{column?.label ?? reach.runtime}</span>
                      </span>
                      {switchable ? (
                        <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
                          <span
                            className={
                              reach.state === 'reaches'
                                ? 'text-(--hd-success-ink)'
                                : 'text-(--hd-muted-foreground)'
                            }
                          >
                            {reach.state === 'reaches' ? 'On' : 'Off'}
                          </span>
                          <Switch
                            checked={reach.state === 'reaches'}
                            disabled={busy === reach.runtime}
                            aria-label={`${entry.name} in ${column?.label ?? reach.runtime}`}
                            onCheckedChange={(next) =>
                              void flip(reach.runtime, reach.reportedPath, next)
                            }
                          />
                        </span>
                      ) : (
                        <span
                          /* `text-balance`: these sentences are longer than
                             the rail is wide and wrapped with one orphaned
                             word — "Installed where this agent does not /
                             look" — on the two states most rows are in. */
                          className={`min-w-0 flex-1 text-right text-balance ${
                            problem
                              ? 'text-(--hd-warning-ink)'
                              : 'text-(--hd-muted-foreground)'
                          }`}
                        >
                          {REACH_SENTENCE[reach.state]}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
              {staleIn.length > 0 && (
                <p className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-(--hd-secondary-foreground)">
                  <span className="min-w-0">
                    {staleIn.length === 1
                      ? `${columns.find((one) => one.id === staleIn[0]?.runtime)?.label ?? 'One agent'} lists the skills it read when it started.`
                      : `${staleIn.length} agents list the skills they read when they started.`}
                  </span>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={rereading}
                    onClick={() => void reread()}
                  >
                    {rereading ? 'Asking…' : 'Have it look again'}
                  </Button>
                </p>
              )}
              {/* Named, one line each. A press can reach three agents and get
                  three different answers back — "it failed" for all of them
                  would be as wrong as the silence this replaced. */}
              {declined.map((one) => (
                <p key={one.runtime} className="m-0 text-xs text-(--hd-warning-ink)">
                  <strong className="font-medium">
                    {columns.find((column) => column.id === one.runtime)?.label ?? one.runtime}
                  </strong>
                  {' \u2014 '}
                  {one.reason}
                </p>
              ))}
              {/* It re-read and still does not list it, so the explanation
                  the line above offers is spent. What is left is a definition
                  this agent will not take. */}
              {rereadAndStillStale.length > 0 && (
                <p className="m-0 text-xs text-(--hd-warning-ink)">
                  {rereadAndStillStale.length === 1
                    ? `${columns.find((one) => one.id === rereadAndStillStale[0]?.runtime)?.label ?? 'It'} re-read and still does not list it — the definition may be one it will not accept.`
                    : `${rereadAndStillStale.length} of them re-read and still do not list it — the definition may be one they will not accept.`}
                </p>
              )}
              {/* The basis, once, rather than on every row. It is the same
                  answer for most machines and repeating it four times turns
                  a caveat into wallpaper. */}
              {entry.reach.some((one) => one.basis === 'scanned') && (
                <p className="m-0 text-xs text-(--hd-muted-foreground)">
                  {entry.reach.every((one) => one.basis === 'scanned')
                    ? 'Read from disk against this build’s table of where each agent looks — the agents themselves were not asked.'
                    : 'Some rows are what the agent itself reported; the rest are read from disk.'}
                </p>
              )}
            </Fact>

            {entry.reach.some((one) => one.note) && (
              <Fact label="Why">
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-(--hd-secondary-foreground)">
                  {entry.reach
                    .filter((one) => one.note)
                    .map((reach) => (
                      <li key={reach.runtime}>
                        {/* An em dash, not a space. The notes are sentences
                            and the labels are names, so "Claude Code On disk,
                            but not in any directory…" ran the two together
                            into something that read like a typo. */}
                        <strong className="font-medium">
                          {columns[entry.reach.indexOf(reach)]?.label ?? reach.runtime}
                        </strong>
                        {' \u2014 '}
                        {reach.note}
                      </li>
                    ))}
                </ul>
              </Fact>
            )}

            <Separator />

            <Fact
              label={entry.copies.length === 1 ? 'One copy on disk' : `${entry.copies.length} copies on disk`}
            >
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {entry.copies.map((one) => (
                  <li key={one.path} className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex min-w-0 items-start gap-1">
                      {/* `anywhere`, not `break-all`: a path only breaks
                          when it has to, so `/home/u/.claude/skills/…` keeps
                          its segments instead of being cut mid-word at the
                          column edge. */}
                      <code
                        className={`${kit.mono} min-w-0 flex-1 text-xs [overflow-wrap:anywhere]`}
                      >
                        {shortPath(one.path, home)}
                      </code>
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
                    <span className="text-xs text-(--hd-muted-foreground)">
                      {one.hollow
                        ? 'No definition inside — the name lists and nothing loads.'
                        : one.readBy.length === 0
                          ? entry.kind === 'mcp'
                            ? 'No agent reads this file.'
                            : 'No agent reads this directory.'
                          : `Read by ${one.readBy
                              .map((id) => columns.find((col) => col.id === id)?.label ?? id)
                              .join(', ')}.`}
                      {one.readOnly && ' Shipped by the agent.'}
                    </span>
                  </li>
                ))}
              </ul>
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
                <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-(--hd-muted-foreground)">Every turn</dt>
                  <dd
                    className="m-0 text-right tabular-nums"
                    title="Name and description at ≈3.6 characters per token — the catalogue line an agent carries for every skill it loads, fired or not."
                  >
                    {entry.catalogTokens ? `≈${entry.catalogTokens} tok` : '—'}
                  </dd>
                  {usage !== null && (
                    <>
                      <dt className="text-(--hd-muted-foreground)">Fired here</dt>
                      <dd className="m-0 text-right tabular-nums">
                        {fired
                          ? `${fired.activations}× in ${fired.sessions} ${
                              fired.sessions === 1 ? 'conversation' : 'conversations'
                            }`
                          : 'never'}
                      </dd>
                      {fired && fired.lastAt > 0 && (
                        <>
                          <dt className="text-(--hd-muted-foreground)">Last</dt>
                          <dd className="m-0 text-right tabular-nums">
                            {new Date(fired.lastAt).toLocaleDateString()}
                          </dd>
                        </>
                      )}
                    </>
                  )}
                </dl>
                {usage !== null && (
                  <p className="m-0 text-xs text-(--hd-muted-foreground)">
                    Counted in the {usage.sessionsScanned} conversations this desk stores. What ran
                    elsewhere is not counted.
                  </p>
                )}
              </Fact>
            )}
          </aside>
        </div>

        {/* --- the verbs ------------------------------------------------ */}
        <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
          {/*
           * The card teaches `/name`; this is where that becomes a thing you
           * did. Same event the per-agent skills page dispatches, so there is
           * one way into the composer and not two that drift.
           */}
          {entry.kind === 'skill' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent('harnessdesk:compose', { detail: `/${entry.name} ` }),
                )
                onClose()
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
                  } agents`,
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
            <span className="flex items-center gap-1.5 text-xs text-(--hd-warning-ink)">
              <AlertIcon size={12} />
              {refusedBy.length === 1
                ? `${columns.find((one) => one.id === refusedBy[0]?.runtime)?.label ?? 'One agent'} would not load this one.`
                : `${refusedBy.length} agents would not load this one.`}
            </span>
          )}
          {installable.length === 0 && (
            <span className="flex items-center gap-1.5 text-xs text-(--hd-muted-foreground)">
              <FileIcon size={12} />
              {entry.reach.every((one) => one.state === 'reaches')
                ? 'Every agent already loads this.'
                : digests.size > 1
                  ? 'Resolve the copies before installing anywhere else.'
                  : 'Nowhere left to install this.'}
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
