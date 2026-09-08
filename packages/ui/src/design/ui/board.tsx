import { forwardRef, useEffect, useRef, useState } from 'react'
import type * as React from 'react'

import { cn } from '@/lib/utils'
import { MoreIcon, PaperclipIcon, PlusIcon, ReviewIcon } from '@/components/Icons'
import { AvatarStack, type StackMember } from './avatar-stack'
import { dotTint, softTone, softTint, type Tint, type Tone } from './tone'

/**
 * Work in columns: what is waiting, what is being done, and who has it.
 *
 * A board is not a list with headings. The claim it makes — and the reason it
 * is worth the horizontal space — is that a card's *column is its state*, so
 * the state never has to be repeated on the card. Every card here therefore
 * says who, how urgent, and how much conversation has accumulated, and none of
 * them says "in progress": the column already did.
 *
 * Two things the references got right and are kept:
 *
 *   The column is a panel, not a gap.   A tinted ground with the cards floating
 *                                       on it means a half-empty column still
 *                                       reads as a column, and a drag has an
 *                                       obvious target. Columns separated by
 *                                       whitespace collapse into ambiguity the
 *                                       moment one of them empties.
 *
 *                                       That claim was only three-quarters
 *                                       true as drawn: the ground was there
 *                                       and the *edge* was not, so an empty
 *                                       column shrank to the height of its own
 *                                       name and the row of five read as three
 *                                       panels and two labels. A column now
 *                                       carries a border and a floor, and both
 *                                       exist for the empty case — the full
 *                                       one never needed either.
 *
 *   The count sits next to the name.    Not in a badge on the right. The
 *                                       question "how many are stuck in review"
 *                                       is asked while reading the name, and an
 *                                       answer at the other end of the header is
 *                                       a second saccade for no reason.
 *
 * One thing they got wrong and is not kept: colouring the column by *state*
 * with the state palette — a green "Done" column and a red "Blocked" column
 * push every card inside them into a verdict they have not earned, and a card
 * sitting in red for three days starts to read as an incident. Columns take a
 * `tint`, which identifies; only the card's `priority` takes a `tone`, which
 * judges. That is the rule in tone.ts, applied where it bites hardest.
 *
 * Drag-and-drop is deliberately not here. The board's *shape* is a design
 * question and belongs in the system; which dnd library moves the cards is an
 * application question, and every column and card below is a plain element a
 * draggable wrapper can take over without this file knowing.
 */

type BoardProps = React.ComponentProps<'div'> & {
  /**
   * Let the columns flow onto a second row instead of scrolling sideways.
   *
   * Off by default, and that default is the rule: columns keep their width and
   * the board scrolls, because a board that reflows its columns to fit has
   * stopped being a board — a column that moved is a column you have to find
   * again, and with user-defined columns there is no order to fall back on.
   *
   * On is for the one shape where the opposite is true: a **fixed, short set of
   * states** in a pane whose width is not the board's to choose. The room's
   * board is five states inside `main`, and `main` gives up width to the right
   * dock, the rail and the watch columns. Scrolling there does not shorten the
   * board, it *hides states* — and the state that scrolls out of sight is
   * Blocked, which is the one a person opened the board to find. Wrapping keeps
   * every column on screen and keeps reading order, which for a fixed set is
   * the whole of what the horizontal line was carrying.
   */
  wrap?: boolean
}

const Board = ({ className, wrap = false, ...props }: BoardProps) => (
  <div
    data-slot="board"
    {...(wrap ? { 'data-wrap': '' } : {})}
    className={cn(
      'items-start gap-3 pb-2',
      wrap
        ? /* The parent decides the column is fluid; the column keeps its own
             fixed width for every other board, and knows nothing about this. */
          'grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] content-start ' +
          '[&>[data-slot=board-column]]:w-auto [&>[data-slot=board-column]]:min-w-0'
        : 'flex overflow-x-auto',
      className,
    )}
    {...props}
  />
)

type BoardColumnProps = Omit<React.ComponentProps<'div'>, 'title'> & {
  title: React.ReactNode
  /** Shown beside the name. Pass `items.length`; it is not inferred. */
  count?: number
  /** Which column this is. Identity, never a verdict — see above. */
  tint?: Tint
  /** The ⋮ menu and anything else that acts on the whole column. */
  actions?: React.ReactNode
  /** Fires the add affordance in the header and the one at the foot. */
  onAdd?: () => void
  addLabel?: string
  /**
   * Take a title here, in the column, without opening anything.
   *
   * When given, the foot's slot stops being a button that opens a form
   * elsewhere and becomes the form: one field, Enter to add, Escape to leave.
   * The header's `+` still opens whatever `onAdd` opens, so the two doors are
   * the quick one and the complete one and each is where it belongs — the
   * quick one at the point the card will appear, the complete one with the
   * rest of the column's controls.
   *
   * It returns nothing on purpose: the caller posts, and the field clears the
   * moment it hands the title over. A field that waits for a promise to settle
   * before clearing is a field that eats the second card someone types.
   */
  onAddTitle?: (title: string) => void
  addPlaceholder?: string
}

const BoardColumn = ({
  className,
  title,
  count,
  tint = 'blue',
  actions,
  onAdd,
  addLabel = 'Add card',
  onAddTitle,
  addPlaceholder = 'What needs doing?',
  children,
  ...props
}: BoardColumnProps) => (
  <section
    data-slot="board-column"
    className={cn(
      /* The border is the half of "a column is a panel" that was missing, and
         `min-h` is the other: an empty column has nothing to give it height,
         and one that collapses to its own title has stopped being a target to
         drop on. The floor is roughly two cards' worth — enough to read as a
         column, short enough that five of them still fit a pane. */
      /* A container, so a card can ask how much room *this column* has rather
         than how wide the pane is. The two are the same question on a board
         of one column and a very different one on a board of five inside a
         room's right half. */
      '@container/board-column flex w-[280px] min-h-40 shrink-0 flex-col gap-2 rounded-(--hd-radius)',
      'border border-(--hd-border-strong) bg-(--hd-muted) p-2.5',
      className,
    )}
    {...props}
  >
    <header className="flex items-center gap-1.5 pb-0.5">
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', dotTint({ tint }))} />
      <h3 className="min-w-0 flex-1 truncate text-base font-medium">{title}</h3>
      {count != null && (
        <span
          /* A count is a fact, so it is set in the figure face and given a
             ground of its own: at 280px the bare number sat close enough to
             the ⋮ and the + to read as a third control. */
          className="inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-(--hd-radius-sm) bg-(--hd-background) px-1 text-xs tabular-nums text-(--hd-muted-foreground)"
        >
          {count}
        </span>
      )}
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          title={addLabel}
          aria-label={addLabel}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-(--hd-radius-sm) text-(--hd-muted-foreground) hover:bg-(--hd-hover) hover:text-(--hd-foreground) [&_svg]:size-3.5"
        >
          <PlusIcon />
        </button>
      )}
      {actions}
    </header>
    <div className="flex min-w-0 flex-col gap-2">{children}</div>
    {/* The second entry point, at the foot where the eye ends after reading the
        column. A composer when the column can take a title on the spot, and a
        plain slot when adding means opening something. */}
    {onAddTitle ? (
      <BoardAddCard onAdd={onAddTitle} label={addLabel} placeholder={addPlaceholder} />
    ) : (
      onAdd && (
        <button
          type="button"
          onClick={onAdd}
          /* Dashed rather than filled: it is a slot, not a card. */
          className="flex items-center justify-center gap-1.5 rounded-(--hd-radius-md) border border-dashed border-(--hd-border-strong) py-2 text-xs text-(--hd-muted-foreground) hover:bg-(--hd-hover) hover:text-(--hd-foreground) [&_svg]:size-3.5"
        >
          <PlusIcon />
          {addLabel}
        </button>
      )
    )}
  </section>
)

/**
 * The slot at the foot of a column, which becomes a field when pressed.
 *
 * A board's quick path has to land where the card will: the reader is looking
 * at the column, they know what the card is called, and the distance between
 * that thought and a card on the board should be a click and a line of text.
 * Putting that field in the pane's header instead — which is what this board
 * did — costs nothing in pixels and everything in meaning, because a field in
 * a header is a filter everywhere else in this app.
 *
 * Three details, each of which is the difference between a composer and a
 * frustration:
 *
 *   Enter adds and stays open.   Boards are filled in runs of three or four.
 *                                Closing after the first would make the second
 *                                a second click.
 *   Escape leaves, and so does   Two ways out, because the field opened from a
 *   a blur with nothing typed.   single click and must not become a mode. A
 *                                blur with text in it keeps the text.
 *   The title clears on hand-    Not on a promise settling. The caller may be
 *   over.                        talking to a host over a socket, and a field
 *                                that waits eats the next thing typed into it.
 */
const BoardAddCard = ({
  onAdd,
  label = 'Add card',
  placeholder = 'What needs doing?',
  className,
}: {
  /* Deliberately not `ComponentProps<'div'>`. This renders a `button` when it
     is closed and a `div` when it is open, so a spread of div props reached
     only half of its own lifetime — every prop a caller passed vanished the
     moment the slot closed. Two elements, one prop set: the set has to be the
     part they share, and that is `className`. */
  onAdd: (title: string) => void
  label?: string
  placeholder?: string
  className?: string
}) => {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) field.current?.focus()
  }, [open])

  const commit = (): void => {
    const text = title.trim()
    if (!text) return
    setTitle('')
    onAdd(text)
  }

  if (!open) {
    return (
      <button
        type="button"
        data-slot="board-add"
        onClick={() => setOpen(true)}
        className={cn(
          'flex items-center justify-center gap-1.5 rounded-(--hd-radius-md) border border-dashed border-(--hd-border-strong) py-2 text-xs text-(--hd-muted-foreground) hover:bg-(--hd-hover) hover:text-(--hd-foreground) [&_svg]:size-3.5',
          className,
        )}
      >
        <PlusIcon />
        {label}
      </button>
    )
  }

  return (
    <div
      data-slot="board-add"
      data-open=""
      className={cn(
        'rounded-(--hd-radius) border border-(--hd-border-strong) bg-(--hd-card) p-1.5 shadow-(--hd-shadow-xs)',
        className,
      )}
    >
      <input
        ref={field}
        value={title}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            setTitle('')
            setOpen(false)
          }
        }}
        onBlur={() => {
          if (!title.trim()) setOpen(false)
        }}
        className="w-full bg-transparent px-1 py-0.5 text-base outline-none placeholder:text-(--hd-muted-foreground)"
      />
    </div>
  )
}

type BoardCardProps = Omit<React.ComponentProps<'div'>, 'title'> & {
  title: React.ReactNode
  /** Who has it. Empty means unassigned, which the card says out loud. */
  assignees?: StackMember[]
  /** The one judgement a card carries. */
  priority?: { label: React.ReactNode; tone: Tone }
  /** A label that identifies rather than judges — a repo, an agent, a workspace. */
  tag?: { label: React.ReactNode; tint: Tint }
  attachments?: number
  comments?: number
  /** A cover image, a diff stat, a `Progress` — anything above the title. */
  cover?: React.ReactNode
  /**
   * The one line that explains the card, under the title.
   *
   * Clamped to two lines, because this is a card and not a document: the
   * board's job is to let the reader skip what is not theirs, and a card that
   * grows with its description stops being scannable at the fourth one. It
   * exists because the alternative — putting the explanation in the title —
   * makes the title unreadable, and leaving it out makes a card that says
   * "blocked" and not why.
   */
  note?: React.ReactNode
  /** The foot's left end: a timestamp, a dependency count, anything small. */
  meta?: React.ReactNode
  actions?: React.ReactNode
}

const BoardCard = ({
  className,
  title,
  assignees,
  priority,
  tag,
  attachments,
  comments,
  cover,
  note,
  meta,
  actions,
  ...props
}: BoardCardProps) => {
  const hasFoot = attachments != null || comments != null || meta != null || actions != null

  return (
    <article
      data-slot="board-card"
      className={cn(
        /* A card is a container, so it takes the container rung of the shape
           ladder rather than the control rung it used to share with the chips
           printed on it. The edge is the stronger of the two border steps:
           a card floating on the column's own grey needs to enclose, and the
           4%-black hairline it had reads as a fold in the ground rather than
           as the edge of an object. */
        'flex min-w-0 flex-col gap-2.5 rounded-(--hd-radius) border border-(--hd-border-strong) bg-(--hd-card) p-2.5 shadow-(--hd-shadow-xs)',
        className,
      )}
      {...props}
    >
      {cover}
      {/* `min-w-0` and `break-words`, together, and both for the same string:
          a title that is one long token with no spaces in it.

          A card's title is written by whoever added the work, and on this
          board that is often a path or a symbol —
          `packages/server/src/methods/conversation.ts::resumeAfterCompaction`
          is a real one. A flex child's minimum size is its content, so
          without `min-w-0` the card widened to fit it; and a word with no
          break opportunity does not wrap, so without `break-words` the text
          simply ran on. Drawn together they let a card push its title
          through its own edge, across the column beside it and out of the
          pane — which is what it did until this fixture was written. */}
      <div className="flex min-w-0 flex-col gap-1">
        <h4 className="text-base leading-snug font-medium break-words">{title}</h4>
        {note && (
          /* Clamped at two lines, and reachable in full on hover when it is
             plain text. The clamp is the right call — a card that grows with
             its description stops being scannable — but a blocked card whose
             reason is three lines long was showing two of them and no way to
             the third, which is the trip to the channel this line exists to
             save. */
          <p
            className="line-clamp-2 text-xs leading-snug break-words text-(--hd-muted-foreground)"
            {...(typeof note === 'string' ? { title: note } : {})}
          >
            {note}
          </p>
        )}
      </div>
      {(assignees != null || priority != null || tag != null) && (
        /* Wraps, and the wrap is the point.
           ------------------------------------------------------------------
           Three things share this row and only two of them can give ground:
           the avatars are a fixed size and the judgement is the news, so a
           narrow column used to crush the tag down to `p.` — a chip with one
           letter in it, which reads as breakage rather than as a truncated
           path. Allowed to wrap, the tag takes a line of its own instead,
           which costs 22px on a card that is already a column and keeps the
           thing it was drawn to say.

           `justify-end` with `mr-auto` on the avatars rather than a spacer
           element, because a spacer is a flex item and would have taken a
           whole line to itself the moment the row wrapped. */
        <div className="flex flex-wrap items-center justify-end gap-2">
          {assignees != null &&
            (assignees.length > 0 ? (
              <AvatarStack className="mr-auto" members={assignees} size="sm" max={3} />
            ) : (
              /* Said, not left blank. An unassigned card and a card whose
                 avatars failed to load look identical otherwise, and the
                 board's whole job is to show who has what. */
              <span className="mr-auto text-xs text-(--hd-muted-foreground)">Unassigned</span>
            ))}
          {tag && (
            /* One line, however long the label. The chip is a fixed height,
               so a label that wrapped — three owned paths joined with commas —
               spilled over the note above and the foot below, and the card
               read as three overlapping paragraphs. The whole label rides on
               the title, where a hover can read it. */
            <span
              className={cn(
                'inline-flex h-(--hd-chip-h) min-w-0 max-w-full items-center truncate rounded-(--hd-radius-sm) px-1.5 text-xs font-medium',
                softTint({ tint: tag.tint }),
              )}
              {...(typeof tag.label === 'string' ? { title: tag.label } : {})}
            >
              <span className="truncate">{tag.label}</span>
            </span>
          )}
          {priority && (
            /* `shrink-0` and `whitespace-nowrap`, for the reason the tag
               beside it already carries: the chip is a fixed height, so a
               label allowed to wrap inside one — "stranded 40m" in a column
               narrowed by the room's rail — spills through its own pill and
               over the rule under it. The judgement is the news on the card,
               so it keeps its width and the tag gives way. */
            <span
              className={cn(
                'inline-flex h-(--hd-chip-h) shrink-0 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap',
                softTone({ tone: priority.tone }),
              )}
            >
              {priority.label}
            </span>
          )}
        </div>
      )}
      {hasFoot && (
        <div className="flex items-center gap-3 border-t border-(--hd-border) pt-2 text-xs text-(--hd-muted-foreground)">
          {meta}
          {attachments != null && (
            <span className="inline-flex items-center gap-1 [&_svg]:size-3.5" title="Attachments">
              <PaperclipIcon />
              <span className="tabular-nums">{attachments}</span>
            </span>
          )}
          {comments != null && (
            <span className="inline-flex items-center gap-1 [&_svg]:size-3.5" title="Comments">
              <ReviewIcon />
              <span className="tabular-nums">{comments}</span>
            </span>
          )}
          <span className="flex-1" />
          {actions}
        </div>
      )}
    </article>
  )
}

/**
 * The ⋮ a column or a card hands to a menu. Sized for both.
 *
 * Forwards its ref, because the only thing this button is ever for is opening
 * a menu — and a menu trigger that cannot be given a ref renders, warns on the
 * console, and then does not position its popover. A component whose single
 * purpose fails silently is worse than one that does not exist.
 */
const BoardMenuButton = forwardRef<HTMLButtonElement, React.ComponentProps<'button'>>(
  ({ className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-label="More"
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-(--hd-radius-sm) text-(--hd-muted-foreground) hover:bg-(--hd-hover) hover:text-(--hd-foreground) [&_svg]:size-3.5',
        className,
      )}
      {...props}
    >
      <MoreIcon />
    </button>
  ),
)
BoardMenuButton.displayName = 'BoardMenuButton'

export { Board, BoardColumn, BoardCard, BoardAddCard, BoardMenuButton }
