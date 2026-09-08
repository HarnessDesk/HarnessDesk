import { useState } from 'react'
import type * as React from 'react'

import {
  AlertIcon,
  BranchIcon,
  CheckIcon,
  ChevronIcon,
  CompactIcon,
  CrossIcon,
  FileIcon,
  GlobeIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  ToolIcon,
  BrainIcon,
  TodoActiveIcon,
  TodoDoneIcon,
  TodoPendingIcon,
} from '@/components/Icons'
import { cn } from '@/lib/utils'
import { softTint, softTone, type Tint, type Tone } from './tone'

/**
 * A conversation, and everything that can turn up inside one.
 *
 * A transcript is not a chat log. Between two sentences of prose an agent may
 * have read eleven files, run a command that failed, asked for permission,
 * pasted a diff, thought for forty seconds, and had its context compacted —
 * and every one of those is a different *kind* of thing, with a different
 * amount of the reader's attention it deserves. Get the hierarchy wrong and
 * the surface fails in one of two directions: everything is a wall of equal
 * grey boxes, or the interesting event is folded away behind a duration.
 *
 * So the blocks here are graded, deliberately, and the grade is the design:
 *
 *   THE ANSWER      Prose. Full size, full contrast, no chrome around it. It
 *                   is what the reader came for and it gets the page.
 *   THE WORK        Steps under a single folded line. Ten reads and two
 *                   commands are one sentence until asked about — except when
 *                   something went wrong, which unfolds itself.
 *   THE ASIDE       Thinking, compaction, resumption. Quiet, small, present.
 *                   Never hidden; a reader who wants to know why an agent went
 *                   that way must be able to find out.
 *   THE DEMAND      An approval. It stops the reading, takes a border and the
 *                   accent, and does not fold. Nothing else in a transcript is
 *                   allowed to look like this, which is what makes it work.
 *
 * The rule underneath all four: **an expected outcome is a whisper, an
 * unexpected one is a chip**. A step that succeeded says how long it took; a
 * step that failed says so, in colour, and pulls its own detail open. This is
 * the same rule the channel already holds for delivery, and it is why a
 * transcript can be scanned rather than read.
 *
 * Presentation only. No store, no protocol types, no clock — a `Turn` is told
 * what it is showing. Wiring these to `AgentItem[]` is the app's business, and
 * keeping that seam is what lets this file be looked at in the explorer with
 * nothing running.
 */

// --- the turn itself --------------------------------------------------------

type TurnProps = React.ComponentProps<'article'> & {
  /** Who spoke. Absent on a person's own turn, which needs no attribution. */
  author?: React.ReactNode
  /** The sender's mark, framed for you. */
  mark?: React.ReactNode
  tint?: Tint
  at?: React.ReactNode
  /** The person's own turn reads differently: quoted, not attributed. */
  role?: 'agent' | 'you'
}

const Turn = ({ className, author, mark, tint = 'blue', at, role = 'agent', children, ...props }: TurnProps) => {
  if (role === 'you') {
    return (
      <article
        data-slot="turn"
        data-role="you"
        /* The person's turn is a quoted block, not a bubble on the right. A
           desk transcript is read like a document — the reader's own words are
           the heading of the passage that follows, and a right-aligned bubble
           breaks the column that the agent's answer needs. */
        className={cn(
          'my-2 border-l-2 border-(--hd-border-strong) py-0.5 pl-3 text-base whitespace-pre-wrap',
          className,
        )}
        {...props}
      >
        {children}
      </article>
    )
  }

  return (
    <article
      data-slot="turn"
      data-role="agent"
      className={cn('grid grid-cols-[24px_1fr] gap-2.5 py-2', className)}
      {...props}
    >
      <div className="flex justify-center pt-0.5">
        {mark != null && (
          <span
            aria-hidden
            className={cn(
              'inline-flex size-6 items-center justify-center rounded-md [&_svg]:size-3.5',
              softTint({ tint }),
            )}
          >
            {mark}
          </span>
        )}
      </div>
      <div className="min-w-0">
        {(author != null || at != null) && (
          <header className="mb-0.5 flex items-baseline gap-2">
            <span className="truncate text-sm font-semibold">{author}</span>
            <span className="ml-auto shrink-0 text-xs text-(--hd-muted-foreground) tabular-nums">
              {at}
            </span>
          </header>
        )}
        <div className="flex min-w-0 flex-col gap-2">{children}</div>
      </div>
    </article>
  )
}

/** The answer. No chrome, because chrome around prose is a box around a sentence. */
const Prose = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="prose"
    className={cn(
      'text-base leading-(--hd-line) [&_a]:text-(--hd-primary-ink) [&_a]:underline [&_code]:rounded-(--hd-radius-sm) [&_code]:bg-(--hd-muted) [&_code]:px-1 [&_code]:font-(family-name:--hd-font-code) [&_code]:text-sm [&_p+p]:mt-2 [&_strong]:font-semibold',
      className,
    )}
    {...props}
  />
)

// --- the work ---------------------------------------------------------------

/** What a step did, once. The verb decides the glyph; the object is the detail. */
export type WorkStepKind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'browse' | 'think' | 'tool' | 'branch'

export type WorkStepState = 'running' | 'done' | 'failed' | 'declined' | 'skipped'

const STEP_ICON: Record<WorkStepKind, React.ComponentType<{ className?: string }>> = {
  read: FileIcon,
  edit: PencilIcon,
  run: TerminalIcon,
  search: SearchIcon,
  web: GlobeIcon,
  browse: GlobeIcon,
  think: BrainIcon,
  tool: ToolIcon,
  branch: BranchIcon,
}

const STATE_TONE: Record<WorkStepState, Tone> = {
  running: 'neutral',
  done: 'neutral',
  failed: 'danger',
  declined: 'warning',
  skipped: 'neutral',
}

type WorkStepProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  kind?: WorkStepKind
  /** The sentence: "Read", "Ran", "Searched". Past tense unless running. */
  verb: React.ReactNode
  /** What it acted on — a path, a command, a query. Set in the code face. */
  object?: React.ReactNode
  state?: WorkStepState
  /** How long, or how much: "1.2s", "6 files", "142 lines". */
  meta?: React.ReactNode
  /** The wire name, for a reader who needs to write a permission rule. */
  wire?: string
  /** Output, a diff, an error — whatever opening the step should reveal. */
  detail?: React.ReactNode
}

const WorkStep = ({
  className,
  kind = 'tool',
  verb,
  object,
  state = 'done',
  meta,
  wire,
  detail,
  ...props
}: WorkStepProps) => {
  /* Trouble opens itself. A declined command folded behind a duration is how a
     transcript ends up looking calm about the thing the reader needed to see. */
  const [open, setOpen] = useState(state === 'failed' || state === 'declined')
  const Glyph = STEP_ICON[kind]
  const tone = STATE_TONE[state]

  return (
    <div data-slot="step" data-state={state} className={cn('min-w-0', className)} {...props}>
      <div
        className={cn(
          'flex min-w-0 items-center gap-2 rounded-(--hd-radius-sm) px-1.5 py-1 text-sm',
          detail != null && 'cursor-pointer hover:bg-(--hd-hover)',
        )}
        {...(detail != null
          ? {
              role: 'button' as const,
              tabIndex: 0,
              'aria-expanded': open,
              onClick: () => setOpen((on) => !on),
              onKeyDown: (event: React.KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setOpen((on) => !on)
                }
              },
            }
          : {})}
      >
        <Glyph
          aria-hidden
          className={cn(
            'size-3.5 shrink-0',
            tone === 'neutral' ? 'text-(--hd-muted-foreground)' : '',
            tone === 'danger' && 'text-(--hd-danger-ink)',
            tone === 'warning' && 'text-(--hd-warning-ink)',
            state === 'running' && 'animate-pulse',
          )}
        />
        <span className="shrink-0 text-(--hd-secondary-foreground)">{verb}</span>
        {object != null && (
          <span className="min-w-0 flex-1 truncate font-(family-name:--hd-font-code) text-xs text-(--hd-foreground)">
            {object}
          </span>
        )}
        <span className="flex-1" />
        {/* Expected outcomes are a whisper; only trouble takes a chip. */}
        {(state === 'failed' || state === 'declined') && (
          <span
            className={cn(
              'shrink-0 rounded-full px-1.5 text-xs font-medium',
              softTone({ tone }),
            )}
          >
            {state}
          </span>
        )}
        {meta != null && (
          <span className="shrink-0 text-xs text-(--hd-muted-foreground) tabular-nums">{meta}</span>
        )}
        {detail != null && (
          <ChevronIcon
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 text-(--hd-muted-foreground) transition-transform',
              open && 'rotate-90',
            )}
          />
        )}
      </div>
      {open && detail != null && (
        <div className="mt-1 ml-5 flex flex-col gap-1.5">
          {wire && (
            <div className="font-(family-name:--hd-font-code) text-xs text-(--hd-muted-foreground)">
              {wire}
            </div>
          )}
          {detail}
        </div>
      )}
    </div>
  )
}

/**
 * The work, under one line.
 *
 * Folded is the reading posture: what stays on screen after a turn finishes is
 * the answer, and the eleven reads that produced it are a sentence. `trouble`
 * inverts that — a turn that failed or had a step declined opens, and tints its
 * own summary, because the alternative is a UI that hides the bad news behind a
 * number.
 */
const Work = ({
  className,
  summary,
  running,
  trouble,
  defaultOpen,
  children,
  ...props
}: Omit<React.ComponentProps<'div'>, 'summary'> & {
  /** "Worked for 1m 14s · read 6 files, ran 2 commands". */
  summary: React.ReactNode
  running?: boolean
  trouble?: boolean
  defaultOpen?: boolean
}) => {
  const [open, setOpen] = useState(defaultOpen ?? Boolean(running || trouble))
  return (
    <div data-slot="work" className={cn('min-w-0', className)} {...props}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((on) => !on)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-(--hd-radius-sm) px-1.5 py-1 text-sm hover:bg-(--hd-hover)',
          trouble ? 'text-(--hd-danger-ink)' : 'text-(--hd-muted-foreground)',
        )}
      >
        <ChevronIcon
          aria-hidden
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <span className={cn('truncate', running && 'animate-pulse')}>{summary}</span>
      </button>
      {open && (
        /* A rule down the left, not a box: the steps are subordinate to the
           line above them, and a border on four sides would make them a
           separate object competing with the answer. */
        <div className="mt-1 ml-2.5 flex flex-col gap-0.5 border-l border-(--hd-border) pl-2">
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * Reasoning, kept quiet.
 *
 * Present and foldable, never absent. An agent's route to an answer is the
 * best evidence a reader has for whether to trust it — but it is evidence, not
 * the answer, so it is small, grey and closed by default.
 */
const Thinking = ({
  className,
  summary = 'Thought',
  children,
  ...props
}: Omit<React.ComponentProps<'div'>, 'summary'> & { summary?: React.ReactNode }) => {
  const [open, setOpen] = useState(false)
  return (
    <div data-slot="thinking" className={cn('min-w-0', className)} {...props}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((on) => !on)}
        className="flex items-center gap-1.5 rounded-(--hd-radius-sm) px-1.5 py-1 text-sm text-(--hd-muted-foreground) hover:bg-(--hd-hover)"
      >
        <BrainIcon aria-hidden className="size-3.5" />
        {summary}
        <ChevronIcon
          aria-hidden
          className={cn('size-3.5 transition-transform', open && 'rotate-90')}
        />
      </button>
      {open && (
        <div className="mt-1 ml-2.5 border-l border-(--hd-border) pl-3 text-sm leading-(--hd-line) text-(--hd-muted-foreground) italic">
          {children}
        </div>
      )}
    </div>
  )
}

// --- what a step reveals ----------------------------------------------------

/**
 * Code, output, a payload.
 *
 * The language chip is not decoration: a block of JSON and a block of shell
 * look alike at a glance and mean very different things about what just
 * happened. `stream="stderr"` tints the ground, because output that arrived on
 * the error channel is a fact worth seeing before the text is read.
 */
const CodeBlock = ({
  className,
  language,
  stream,
  children,
  ...props
}: React.ComponentProps<'pre'> & { language?: string; stream?: 'stdout' | 'stderr' }) => (
  <div className="min-w-0">
    {language != null && (
      <div className="mb-1 font-(family-name:--hd-font-code) text-xs text-(--hd-muted-foreground)">
        {language}
      </div>
    )}
    <pre
      data-slot="code-block"
      data-stream={stream}
      className={cn(
        'max-h-64 overflow-auto rounded-(--hd-radius-sm) px-2.5 py-2 font-(family-name:--hd-font-code) text-xs leading-5',
        stream === 'stderr'
          ? 'bg-(--hd-danger-dim) text-(--hd-danger-ink)'
          : 'bg-(--hd-muted) text-(--hd-foreground)',
        className,
      )}
      {...props}
    >
      {children}
    </pre>
  </div>
)

/** How much a file moved: the two numbers, and the bar that makes them scannable. */
const DiffStat = ({
  className,
  added,
  removed,
  ...props
}: Omit<React.ComponentProps<'span'>, 'children'> & { added: number; removed: number }) => {
  const total = added + removed || 1
  const blocks = 5
  const green = Math.round((added / total) * blocks)
  return (
    <span
      data-slot="diff-stat"
      className={cn('inline-flex items-center gap-1.5 text-xs tabular-nums', className)}
      {...props}
    >
      <span className="text-(--hd-success-ink)">+{added}</span>
      <span className="text-(--hd-danger-ink)">−{removed}</span>
      <span aria-hidden className="flex gap-px">
        {Array.from({ length: blocks }, (_, index) => (
          <span
            key={index}
            className={cn(
              'size-1.5 rounded-(--hd-radius-sm)',
              index < green ? 'bg-(--hd-success)' : 'bg-(--hd-danger)',
            )}
          />
        ))}
      </span>
    </span>
  )
}

export type DiffLine = { kind: 'add' | 'remove' | 'context' | 'hunk'; text: string }

/**
 * A change, in the only form that answers "what exactly did it do".
 *
 * Not a summary and not a file list — the lines. A transcript that reports "3
 * files changed" and makes the reader open an editor to find out what changed
 * has moved the work rather than done it.
 */
const DiffBlock = ({
  className,
  file,
  added,
  removed,
  lines,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  file: React.ReactNode
  added: number
  removed: number
  lines: DiffLine[]
}) => (
  <div
    data-slot="diff-block"
    className={cn('overflow-hidden rounded-(--hd-radius-sm) border border-(--hd-border)', className)}
    {...props}
  >
    <div className="flex items-center gap-2 bg-(--hd-muted) px-2.5 py-1.5">
      <FileIcon aria-hidden className="size-3.5 shrink-0 text-(--hd-muted-foreground)" />
      <span className="min-w-0 flex-1 truncate font-(family-name:--hd-font-code) text-xs">
        {file}
      </span>
      <DiffStat added={added} removed={removed} />
    </div>
    <div className="max-h-64 overflow-auto font-(family-name:--hd-font-code) text-xs leading-5">
      {lines.map((line, index) => (
        <div
          key={index}
          data-kind={line.kind}
          className={cn(
            'px-2.5 whitespace-pre',
            line.kind === 'add' && 'bg-(--hd-success-dim) text-(--hd-foreground)',
            line.kind === 'remove' && 'bg-(--hd-danger-dim) text-(--hd-foreground)',
            line.kind === 'hunk' && 'bg-(--hd-muted) text-(--hd-muted-foreground)',
            line.kind === 'context' && 'text-(--hd-secondary-foreground)',
          )}
        >
          {/* The marker is part of the line, so a copied selection is a patch
              rather than a column of text that has to be re-marked by hand. */}
          {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
          {line.text}
        </div>
      ))}
    </div>
  </div>
)

/**
 * A file the turn touched, as one line.
 *
 * The status letter is a letter and not a colour alone: A, M, D, R read the
 * same to everyone, and the colour is the second channel rather than the only
 * one.
 */
const FileRow = ({
  className,
  status,
  path,
  added,
  removed,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  status: 'A' | 'M' | 'D' | 'R'
  path: React.ReactNode
  added?: number
  removed?: number
}) => {
  const tone: Tone =
    status === 'A' ? 'success' : status === 'D' ? 'danger' : status === 'R' ? 'info' : 'neutral'
  return (
    <div
      data-slot="file-row"
      className={cn('flex items-center gap-2 px-2 py-1 text-sm', className)}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          'inline-flex size-4 shrink-0 items-center justify-center rounded-(--hd-radius-sm) text-xs font-semibold',
          softTone({ tone }),
        )}
      >
        {status}
      </span>
      <span className="min-w-0 flex-1 truncate font-(family-name:--hd-font-code) text-xs">
        {path}
      </span>
      {added != null && removed != null && <DiffStat added={added} removed={removed} />}
    </div>
  )
}

// --- the demand -------------------------------------------------------------

/**
 * The one block in a transcript that stops the reading.
 *
 * A border, the accent, no fold, and the options as real buttons. It looks like
 * nothing else here on purpose: the reader has to be able to tell, while
 * scrolling past at speed, that this one is waiting for them. Once it has been
 * answered it keeps the shape and states the outcome, so the history says what
 * was decided rather than quietly closing up.
 */
const Approval = ({
  className,
  title,
  detail,
  outcome,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  title: React.ReactNode
  /** What is actually being asked for — the command, the path, the host. */
  detail?: React.ReactNode
  /** Once decided, what was decided. Replaces the buttons. */
  outcome?: { label: React.ReactNode; tone: Tone }
}) => (
  <div
    data-slot="approval"
    data-answered={outcome ? '' : undefined}
    className={cn(
      'rounded-(--hd-radius) border p-3',
      outcome
        ? 'border-(--hd-border) bg-(--hd-card)'
        : 'border-(--hd-primary) bg-(--hd-primary-muted)',
      className,
    )}
    {...props}
  >
    <div className="flex items-start gap-2">
      <AlertIcon
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0',
          outcome ? 'text-(--hd-muted-foreground)' : 'text-(--hd-primary-ink)',
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium">{title}</div>
        {detail != null && (
          <div className="mt-1 font-(family-name:--hd-font-code) text-xs break-all text-(--hd-secondary-foreground)">
            {detail}
          </div>
        )}
      </div>
      {outcome && (
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
            softTone({ tone: outcome.tone }),
          )}
        >
          {outcome.label}
        </span>
      )}
    </div>
    {!outcome && children != null && (
      <div className="mt-2.5 flex flex-wrap items-center gap-2">{children}</div>
    )}
  </div>
)

/** Something went wrong that was not a step's fault — the turn's own failure. */
const Problem = ({
  className,
  title,
  children,
  ...props
}: React.ComponentProps<'div'> & { title: React.ReactNode }) => (
  <div
    data-slot="problem"
    className={cn(
      'rounded-(--hd-radius-sm) border border-(--hd-danger)/40 bg-(--hd-danger-dim) p-2.5',
      className,
    )}
    {...props}
  >
    <div className="flex items-center gap-2 text-sm font-medium text-(--hd-danger-ink)">
      <CrossIcon aria-hidden className="size-3.5" />
      {title}
    </div>
    {children != null && (
      <div className="mt-1.5 text-xs text-(--hd-secondary-foreground)">{children}</div>
    )}
  </div>
)

// --- the asides -------------------------------------------------------------

/*
 * `Marker` used to live here, drawn as a labelled separator and nothing else.
 * It moved to design/ui/marker.tsx when the registry's version was adopted:
 * three variants rather than one, a polymorphic root, and the same part names,
 * so this file's callers changed shape rather than meaning.
 */

export type Todo = { text: string; state: 'done' | 'active' | 'pending' }

/**
 * The plan, and how far through it the agent is.
 *
 * Three states, three glyphs, and the active one carries weight — a list where
 * only colour distinguishes "doing" from "to do" is a list nobody can read at a
 * glance, which defeats the point of publishing a plan at all.
 */
const Todos = ({
  className,
  items,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & { items: Todo[] }) => (
  <div
    data-slot="todos"
    className={cn(
      'flex flex-col gap-1 rounded-(--hd-radius-sm) bg-(--hd-muted) px-2.5 py-2',
      className,
    )}
    {...props}
  >
    {items.map((item) => (
      <div key={item.text} className="flex items-start gap-2 text-sm">
        {item.state === 'done' && (
          <TodoDoneIcon aria-label="Done" className="mt-0.5 size-3.5 shrink-0 text-(--hd-success-ink)" />
        )}
        {item.state === 'active' && (
          <TodoActiveIcon aria-label="In progress" className="mt-0.5 size-3.5 shrink-0 text-(--hd-primary-ink)" />
        )}
        {item.state === 'pending' && (
          <TodoPendingIcon aria-label="To do" className="mt-0.5 size-3.5 shrink-0 text-(--hd-muted-foreground)" />
        )}
        <span
          className={cn(
            'min-w-0',
            item.state === 'done' && 'text-(--hd-muted-foreground) line-through',
            item.state === 'active' && 'font-medium',
            item.state === 'pending' && 'text-(--hd-secondary-foreground)',
          )}
        >
          {item.text}
        </span>
      </div>
    ))}
  </div>
)

/*
 * `Attachment` used to live here as a static chip &mdash; a thumbnail, a name,
 * a size. It moved to design/ui/attachment.tsx with the registry's version,
 * which has the thing this one never did: the upload states. A file is in
 * flight before it is attached, and the composer had nowhere to say so.
 */

/** A tick, for a step that produced nothing worth showing. */
const WorkStepDone = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    className={cn('inline-flex items-center gap-1 text-xs text-(--hd-success-ink)', className)}
    {...props}
  >
    <CheckIcon aria-hidden className="size-3" />
  </span>
)

export {
  Turn,
  Prose,
  Work,
  WorkStep,
  WorkStepDone,
  Thinking,
  CodeBlock,
  DiffBlock,
  DiffStat,
  FileRow,
  Approval,
  Problem,
  Todos,
}
