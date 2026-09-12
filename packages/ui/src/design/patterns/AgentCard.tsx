import type { ReactNode } from 'react'

import { AlertIcon, InfoIcon, ShieldOffIcon } from '../../components/Icons'
import { Segmented } from '../primitives/Kit'
import { Button } from '../ui/button'
import { IconTile } from '../ui/icon-tile'
import { Progress } from '../ui/progress'
import type { Tint } from '../ui/tone'

/**
 * Who an agent is, in one card.
 *
 * Everywhere in this app an agent is a 20px mark and a short name. The mark
 * says which harness; the name says which one of them *here*. Everything else
 * — the model it is on, whose account pays, what it is doing right now, how
 * much context is left, whether it can take a job at all — is missing,
 * truncated into a grey subtitle, or three screens away.
 *
 * Slack answered this with the member card, Discord with the profile popout.
 * Both are about people. Ours is not: an agent here is a running process with
 * a credential, a model, a workspace, a context budget and a job. So the card
 * borrows their shape — rest on the face, get the whole answer, act without
 * leaving — and fills it with instruments rather than a bio.
 *
 * ---------------------------------------------------------------------------
 * Four subjects, one anatomy
 *
 * Point at a mark in this app and you may be pointing at any of four things,
 * and they nest:
 *
 *   AGENT     the harness itself, with no credential yet. Sign-in, Add member.
 *   ACCOUNT   a harness *plus* a credential. Sidebar seat, composer, Usage.
 *   SESSION   one conversation. Session tree, Archive, sub-agents.
 *   MEMBER    a session inside a room, with a nickname. Rail, chat, board.
 *
 * A card that pretended they were one thing would either lie by whitespace or
 * refuse to say the useful part, so there is one anatomy and each subject
 * fills the bands it can honestly fill. **A band with nothing true to say is
 * not drawn, and the divider above it goes with it.** That is the app's
 * second-line rule (docs/design.md) at the scale of a card: height is
 * information here, and a card that held its size by padding out empty bands
 * would be reporting a confidence it does not have.
 *
 * The bands, in order:
 *
 *   Crest    the mark on the account's own ring, the name, and the two facts
 *            the row never had room for — which harness, whose credential.
 *   Running  model and effort, the harness version dimmed at the end, and the
 *            state as a fact *with a number*: "Working — 41s into this turn".
 *            The bare word "Working" would only repeat the lamp on the mark.
 *   Meter    the one number the reader came for. Context for a session, the
 *            plan's remaining budget for an account — the same band, because
 *            both answer "how much of this can I still spend".
 *   On       the job, then the ground it stands on. In the rail this is one
 *            truncated line; here it is two full ones, and the task title
 *            wraps rather than clipping.
 *   Caution  *every* caution, not the highest-ranked one. The rail can show
 *            one and drops the loser; this is the band that most plainly
 *            earns the card over a longer tooltip.
 *   Do       the verbs this surface offers, never a fixed set. A verb that
 *            would fail is absent rather than greyed — a card is not a menu.
 *
 * Presentation only: no store, no session, no context. The screen builds the
 * subject and hands over the verbs; see components/AgentCards.tsx for the
 * readers that turn app state into one of these.
 */

/** Which of the four things this card is about. Shapes nothing but the copy. */
export type AgentCardKind = 'agent' | 'account' | 'session' | 'member'

export type AgentCardAction = {
  readonly label: string
  readonly onSelect: () => void
  /** At most one. The verb a reader who opened this card most likely wants. */
  readonly primary?: boolean
}

/**
 * Something the reader should know before handing this agent work.
 *
 * `danger` is a refusal — it cannot do the thing. `warning` is a doubt.
 * `quiet` is an observation that is neither, and it must not shout as loudly
 * as one; the room's "has not used the board" is the case that forced the
 * third level.
 */
export type AgentCardCaution = {
  readonly tone: 'danger' | 'warning' | 'quiet'
  readonly text: string
}

/**
 * A budget and what is left of it.
 *
 * `left` and `of` rather than used-and-total, deliberately: `Progress` fills
 * with the value it is given and never inverts, so a remaining-budget reading
 * is produced by passing the remaining value and labelling it as such. Passing
 * the spent value with a "left" label is how a bar comes to contradict the
 * number beside it.
 */
export type AgentCardMeter = {
  /** "Context", "Plan" — what budget this is. */
  readonly label: string
  readonly left: number
  readonly of: number
  /** The reading, spelled by the caller: "740K left of 1M". */
  readonly reading: string
  /**
   * The verdict the fill carries. A budget is one of the few places a `tint`
   * would be wrong: running low *is* bad news, and green here means "plenty
   * left", not "this one is the green agent".
   */
  readonly tone?: 'success' | 'warning' | 'danger'
}

export type AgentCardSubject = {
  readonly kind: AgentCardKind
  /** What it is called here — the nickname in a room, the session's title elsewhere. */
  readonly name: string
  /**
   * A second name it also answers to, beside the first rather than under it.
   *
   * A member holding a job has not stopped being the conversation somebody
   * named. Absent when it would only repeat `name`.
   */
  readonly also?: string | null
  /** Which harness and whose credential: "Claude Code · shane@harnessdesk.app". */
  readonly identity?: string | null
  readonly tint: Tint
  /** The harness's own mark. `aria-hidden`; the name above spells it. */
  readonly mark: ReactNode
  /** Mid-turn. A light on the mark, never a word — the app's rule everywhere. */
  readonly working?: boolean
  readonly running?: {
    /** "Opus 5 · Max effort". */
    readonly model?: string | null
    /** The harness's version, dimmed at the line's end. */
    readonly version?: string | null
    /** "Working — 41s into this turn", "Idle — last spoke 4 minutes ago". */
    readonly state?: string | null
  } | null
  readonly meter?: AgentCardMeter | null
  readonly on?: {
    /** The board id an agent is actually addressed by — "#3". */
    readonly taskId?: string | null
    readonly title?: string | null
    /** Workspace and branch, in the code face. */
    readonly where?: string | null
  } | null
  readonly cautions?: readonly AgentCardCaution[]
  /**
   * A setting with a small closed set of values — not a verb.
   *
   * The distinction earns its own band. The room's inbound mode arrived as
   * three more entries in `actions`, which pushed that row to five buttons: it
   * does not wrap, so "Turn messages away" and "Take out of the room" were off
   * the card's edge and "Hold messages for me" was cut mid-word. Photographed,
   * which is how it was found. A thing with three states belongs in a
   * segmented control that shows which one it is in, beside the other
   * instruments — and the verbs go back to being verbs.
   */
  readonly choice?: {
    /** The band's heading, and the control's accessible name: "Messages". */
    readonly label: string
    readonly value: string
    readonly options: readonly { readonly value: string; readonly label: string }[]
    readonly onChange: (next: string) => void
  } | null
  readonly actions?: readonly AgentCardAction[]
}

const CAUTION_STYLE = {
  danger: 'bg-(--hd-danger-dim) text-(--hd-danger-ink)',
  warning: 'bg-(--hd-warning-dim) text-(--hd-warning-ink)',
  quiet: 'text-(--hd-muted-foreground)',
} as const

const CAUTION_ICON = {
  danger: ShieldOffIcon,
  warning: AlertIcon,
  quiet: InfoIcon,
} as const

/** A band, drawn only because its caller had something to put in it. */
const Band = ({ label, children }: { label?: string; children: ReactNode }) => (
  /* Named, because how many bands were drawn is the rule this component
     exists to keep and a test has to be able to ask. Counting `border-t`
     instead coupled that test to a divider style, so a restyle that used a
     gap or an `<hr>` would have broken the test without breaking the rule. */
  <div data-slot="agent-card-band" className="border-t border-(--hd-border-strong) px-3 py-2.5">
    {label && (
      <p className="mb-1 font-(family-name:--hd-font-code) text-xs font-medium tracking-widest text-(--hd-muted-foreground) uppercase">
        {label}
      </p>
    )}
    {children}
  </div>
)

export const AgentCard = ({ subject }: { subject: AgentCardSubject }) => {
  const { running, meter, on, cautions = [], choice = null, actions = [] } = subject
  /* Earned, band by band. `running` can arrive as an object with every field
     empty — a session the renderer has never opened knows the harness and
     nothing else — and an empty object must not draw a divider. */
  const hasRunning = Boolean(running && (running.model || running.state))
  const hasOn = Boolean(on && (on.title || on.where))
  /* A card never prints the same string twice. A room names its members after
     the agent by default, so an unnicknamed Claude Code conversation arrives
     with `name` and `identity` both reading "Claude Code" — and the crest then
     spends its second line restating its first. The rule is the app's own
     (`actorName` in Channel.tsx refuses "Alpha (Alpha)" for the same reason);
     it lives here so every caller gets it rather than each remembering.

     Exact equality only: "Claude Code · olivia" and "Claude Code · not signed
     in" both begin with the name and both carry news after it. */
  const identity = subject.identity && subject.identity !== subject.name ? subject.identity : null
  const also = subject.also && subject.also !== subject.name ? subject.also : null

  return (
    <div className="text-(--hd-card-foreground)" data-slot="agent-card" data-kind={subject.kind}>
      {/* Crest */}
      <div className="flex items-start gap-2.5 px-3 pt-3 pb-2.5">
        <span className="relative flex-none">
          <IconTile tint={subject.tint}>{subject.mark}</IconTile>
          {/* Working is a light, not a word — the same dot the rail draws, in
              the same corner. Announced in words on the name, where a screen
              reader gets a sentence rather than a colour. */}
          {subject.working && (
            <span
              aria-hidden
              className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-(--hd-success) ring-2 ring-(--hd-popover)"
            />
          )}
        </span>
        <span className="min-w-0 flex-1 pt-px">
          {/* The whole of a name that does not fit.
              A card is 288px wide beside a 16px tile, so a long name truncates
              here as well as in the row it was opened from — and the row's own
              tooltip is gone wherever a card opens on the same rest, which left
              a long conversation title cut in both places and whole in neither.
              This is a *different* rest, on a surface the reader has already
              chosen to open, so it stacks no second box on the trigger's; and
              it is one attribute for every card in the app rather than one per
              caller. Unconditional, because nothing here can know whether a
              name fits its line: where it does, the tooltip repeats it, which
              is what a native title does everywhere and costs a rest nobody
              makes. */}
          <span className="flex items-baseline gap-1.5 text-sm leading-tight font-semibold">
            <span className="truncate" title={subject.name}>
              {subject.name}
            </span>
            {also && (
              <span
                className="min-w-0 truncate text-xs font-normal text-(--hd-muted-foreground)"
                title={also}
              >
                {also}
              </span>
            )}
            {subject.working && <span className="sr-only"> — working</span>}
          </span>
          {identity && (
            <span className="mt-px block truncate text-xs text-(--hd-muted-foreground)">
              {identity}
            </span>
          )}
        </span>
      </div>

      {hasRunning && running && (
        <Band label="Running">
          {running.model && (
            <div className="flex items-baseline gap-1.5">
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{running.model}</span>
              {running.version && (
                <span className="flex-none font-(family-name:--hd-font-code) text-xs text-(--hd-muted-foreground) tabular-nums">
                  {running.version}
                </span>
              )}
            </div>
          )}
          {running.state && (
            <div className="mt-0.5 text-xs text-(--hd-muted-foreground)">{running.state}</div>
          )}
        </Band>
      )}

      {meter && (
        <Band label={meter.label}>
          {/* The bar fills with what is LEFT because the value passed is what
              is left; `Progress` does not invert, and the label says which
              number it is showing. */}
          <Progress
            size="sm"
            value={meter.left}
            max={meter.of}
            tone={meter.tone ?? 'success'}
            label={false}
            className="mb-1.5"
          />
          <div className="text-xs tabular-nums">{meter.reading}</div>
        </Band>
      )}

      {hasOn && on && (
        <Band label="On">
          {on.title && (
            <div className="flex items-baseline gap-1.5">
              {on.taskId && (
                <span className="flex-none rounded-(--hd-radius-sm) bg-(--hd-primary-muted) px-1 font-(family-name:--hd-font-code) text-xs font-medium text-(--hd-primary-ink)">
                  {on.taskId}
                </span>
              )}
              {/* The job is why the card was opened; it wraps rather than
                  clipping, which is the whole difference from the rail. */}
              <span className="min-w-0 flex-1 text-xs">{on.title}</span>
            </div>
          )}
          {on.where && (
            <div className="mt-0.5 truncate font-(family-name:--hd-font-code) text-xs text-(--hd-muted-foreground)">
              {on.where}
            </div>
          )}
        </Band>
      )}

      {/* Every caution, not the highest-ranked one. */}
      {cautions.map((caution) => {
        const Glyph = CAUTION_ICON[caution.tone]
        return (
          <div
            key={caution.text}
            data-slot="agent-card-band"
            className={`flex items-start gap-2 border-t border-(--hd-border-strong) px-3 py-2 text-xs leading-snug ${CAUTION_STYLE[caution.tone]}`}
          >
            <Glyph size={13} className="mt-px flex-none" />
            <span>{caution.text}</span>
          </div>
        )
      })}

      {choice && (
        <Band label={choice.label}>
          {/* Named so the card can tell a setting from a verb: every other
              control here acts on something behind the card and dismisses it,
              and a picker that vanished the instant you chose would never show
              you what you had chosen. */}
          <span data-slot="agent-card-choice">
            <Segmented
              label={choice.label}
              value={choice.value}
              options={choice.options}
              onChange={choice.onChange}
            />
          </span>
        </Band>
      )}

      {actions.length > 0 && (
        /* Wrapping, because a row of verbs is not a fixed width: the labels are
           sentences in some subjects and one word in others, and the row that
           overflowed had three of them. */
        <div
          data-slot="agent-card-band"
          className="flex flex-wrap gap-1.5 border-t border-(--hd-border-strong) px-3 py-2.5"
        >
          {actions.map((action) => (
            <Button
              key={action.label}
              size="sm"
              variant={action.primary ? 'default' : 'outline'}
              onClick={action.onSelect}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
AgentCard.displayName = 'AgentCard'
