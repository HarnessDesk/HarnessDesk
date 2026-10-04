import {
  followOf, type Approval, type ApprovalDecision, type ApprovalId, type FlowExecution, type FlowPolicy, type Intent, type SessionKey,
} from '@harnessdesk/protocol'
import { wordOf } from './agents'
import { approvalChoiceOrder } from './approval-order'
import { flowStepOf } from './board-facts'
import { boardToolLabel, boardToolNamedBy, boardToolPlacement } from './board-tool-note'

/**
 * What a person can do about what needs them, as plain data the Overview's
 * Needs-you rows and the Run inspector both draw: the answers a step offers
 * and what each will do, what abandoning a card will do, and the choices an
 * approval or a question holds. Nothing here reads a store or a component.
 *
 * The consequence sentences are read from the Run's own frozen Flow
 * (`followOf`), because the host's reply to an answer or an abandon says
 * nothing of them. Where the Flow cannot be read that way a sentence says so
 * rather than guess.
 */

const finished = (card: Intent | undefined): boolean => card?.state === 'done' || card?.state === 'abandoned'

/** A card that has not finished: open, claimed or blocked. */
export const abandonable = (card: Intent): boolean => !finished(card)

/** What opening a role is, in the words a person reads: an agent's round, a check, or a step that is theirs. */
const opens = (flow: Pick<FlowPolicy, 'roles'>, role: string): string => {
  const kind = flow.roles.find((one) => one.id === role)?.kind
  return kind === 'person' ? 'a step for you' : kind === 'check' ? `the ${role} check` : `a ${role} round`
}

// ------------------------------------------------------------ a person's step

export interface StepAnswer {
  /** The word the answer carries; null on a step that declares none, which the board offers as "Mark done". */
  readonly outcome: string | null
  /** What the Run does after it, or null when the Flow cannot be read that way. */
  readonly effect: string | null
}

export type StepDoor =
  | { readonly kind: 'answer'; readonly card: number; readonly answers: readonly StepAnswer[] }
  /** A review step needs the attempt it answers for, which only the board's picker records. */
  | { readonly kind: 'review'; readonly card: number }

const answerEffect = (flow: FlowPolicy, role: string, outcome: string | null, state: FlowExecution['state']): string => {
  const said = outcome === null ? 'Marking it done' : wordOf(outcome)
  // The engine decides a round only while its Run is running, so an answer to a Run that is not is only recorded.
  if (state === 'stalled') return `${said} is recorded, and no rule follows while this Run is stalled.`
  if (state !== 'running') return `${said} is recorded, and no rule follows: this Run is ${state}.`
  const follow = followOf(flow, role, [outcome])
  if (follow.kind === 'opens') {
    return follow.guarded
      ? `${said} may open ${opens(flow, follow.role)}, depending on the Run's evidence.`
      : `${said} opens ${opens(flow, follow.role)}.`
  }
  // The engine settles a Run as complete only when no rule starts from the role and the card carries an answer.
  return !follow.ruled && outcome !== null ? `${said} finishes the Run.` : `${said} ends the Run without a next step.`
}

/**
 * The way to answer a card a Flow addressed to a person, or null when it has
 * none: the card is not a person's step in this Run, or has been answered or
 * set aside. The words are the role's own, the same ones the board offers.
 */
export const stepDoor = (card: Intent, execution: FlowExecution | null | undefined): StepDoor | null => {
  if (!execution || finished(card)) return null
  const step = flowStepOf(card, undefined, [execution])
  if (step?.kind !== 'person') return null
  if (step.review) return { kind: 'review', card: card.id }
  const flow = execution.document.format === 'agents' ? execution.document.flow : null
  const role = card.role ?? ''
  const words: readonly (string | null)[] = step.outcomes.length > 0 ? step.outcomes : [null]
  return {
    kind: 'answer', card: card.id,
    answers: words.map((outcome) => ({ outcome, effect: flow ? answerEffect(flow, role, outcome, execution.state) : null })),
  }
}

// ----------------------------------------------------------- abandoning a card

const GENERIC = 'Abandoning sets the card aside. If a rule follows its role, the next round opens as usual.'

/**
 * What abandoning this card will do to its Run, said the way the engine will
 * do it: nothing after a Run that is not running or a round that is over; the
 * round's decision still to come while its other cards are unfinished; and
 * otherwise the rule that reads the round with this card as it stands, which
 * for an abandoned card has no answer.
 */
export const abandonEffect = (execution: FlowExecution, cards: readonly Intent[], card: Intent): string => {
  const round = execution.rounds.find((one) => one.cards.includes(card.id))
  const document = execution.document
  if (!round || document.format !== 'agents') return GENERIC
  if (execution.state !== 'running') return `This Run is ${execution.state}, so no rule follows${execution.state === 'stalled' ? ' now' : ''}: abandoning only sets the card aside.`
  if (round.state === 'closed' || execution.rounds.at(-1)?.n !== round.n) return 'Its round has already ended, so no rule follows: abandoning only sets the card aside.'
  // The engine reads a card it cannot find as unfinished, so the round keeps waiting for it.
  const unfinished = round.cards.filter((id) => id !== card.id && !finished(cards.find((one) => one.id === id)))
  if (unfinished.length > 0) {
    return `Round ${round.n} stays open until its other ${unfinished.length === 1 ? 'card finishes' : 'cards finish'} (${unfinished.map((id) => `#${id}`).join(', ')}). `
      + `Then the rule that follows the ${round.role} role decides, with this card counting as no answer.`
  }
  const flow = document.flow
  const follow = followOf(flow, round.role, round.cards.map((id) => (id === card.id ? card : cards.find((one) => one.id === id))?.outcome ?? null))
  if (follow.kind === 'opens') {
    return follow.guarded
      ? `The rule that follows the ${round.role} role still applies, so abandoning this card may open ${opens(flow, follow.role)}, depending on the Run's evidence.`
      : `The rule that follows the ${round.role} role still fires, so abandoning this card opens ${opens(flow, follow.role)}.`
  }
  return follow.ruled
    ? `No rule that follows the ${round.role} role accepts a card with no answer, so abandoning this card ends the Run without a next step.`
    : `Nothing follows the ${round.role} role, so abandoning this card ends the Run without a next step.`
}

// ----------------------------------------------------- an approval or question

/**
 * Everything a Needs-you row and the Run inspector can do about what needs a
 * person, so the screens that draw them hold no store: the doors, and the
 * calls that answer through them. `respond` and `answerStep` are the same
 * requests the docked approval and the board make.
 */
export interface NeedsYouAnswers {
  /** The way to answer a person's card, or null when it has none now. */
  readonly stepDoor: (card: number) => StepDoor | null
  /** The way to answer an open approval or question, with the conversation it belongs to. */
  readonly approvalDoor: (approval: ApprovalId) => (ApprovalDoor & { readonly key: SessionKey }) | null
  /** Answers a person's card, and rejects with the host's refusal. */
  readonly answerStep: (card: number, outcome: string | null, note: string) => Promise<void>
  readonly respond: (key: SessionKey, approval: ApprovalId, decision: ApprovalDecision) => void
  /** Opens the board, where a review step's attempt is picked. */
  readonly openBoard: () => void
}

export interface ApprovalChoice {
  readonly id: string
  readonly label: string
  /** The plain yes is the one filled answer; every other is quiet. */
  readonly primary: boolean
  readonly decision: ApprovalDecision
  /** What the agent said this choice does, on hover. */
  readonly title?: string
}

/** What is being approved, so a yes is never given blind: the command whole, the files a change touches, what an access would open, and why the runtime asks. */
export interface ApprovalDetail {
  readonly code?: string
  readonly reason?: string
  readonly lists?: readonly { readonly label: string; readonly items: readonly string[] }[]
}

export interface ApprovalDoor {
  readonly detail: ApprovalDetail
  readonly choices: readonly ApprovalChoice[]
  /** The request needs more than a button, so its conversation holds the form to answer it. */
  readonly elsewhere: boolean
}

/** How a runtime words the board-tool grants, when it has its own words for them. */
export interface BoardToolWords {
  readonly sessionOptionLabel?: string | undefined
  readonly onceOptionLabel?: string | undefined
}

const detailOf = (approval: Exclude<Approval, { type: 'userInput' | 'elicitation' }>): ApprovalDetail => {
  const lists = approval.type === 'fileChange' ? [{ label: 'Files', items: approval.changes.map((change) => change.path) }]
    : approval.type === 'permission' ? [{ label: 'Folders', items: approval.filesystem ?? [] }, { label: 'Network', items: approval.network ?? [] }]
      : []
  return {
    // What a running command is asked to take is the input, and what is approved is that.
    ...(approval.type === 'command' ? { code: approval.kind === 'stdin' ? approval.input ?? approval.command : approval.command } : {}),
    ...(approval.reason ? { reason: approval.reason } : {}),
    ...(lists.some((one) => one.items.length > 0) ? { lists: lists.filter((one) => one.items.length > 0) } : {}),
  }
}

const CANCEL: ApprovalChoice = { id: 'cancel', label: 'Cancel', primary: false, decision: { type: 'cancel' } }

/**
 * The choices an approval's second door offers. They are the agent's own, in
 * the docked card's order and with its words, and each answers through the
 * same decision the card sends, so the first to answer wins as it does today.
 * A question that needs a form is left to its conversation, and only the
 * cancel is offered here.
 */
export const approvalDoor = (approval: Approval, boardTool?: BoardToolWords | null): ApprovalDoor => {
  if (approval.type === 'userInput') {
    const [only] = approval.questions
    const simple = approval.questions.length === 1 && only !== undefined && !only.multiSelect && only.options.length > 0
    return {
      detail: {},
      elsewhere: !simple,
      choices: simple
        ? [...only.options.map((option): ApprovalChoice => ({
          id: `answer-${option.id}`, label: option.label, primary: false,
          decision: { type: 'answers', answers: { [only.id]: [option.id] } },
          ...(option.description ? { title: option.description } : {}),
        })), CANCEL]
        : [CANCEL],
    }
  }
  if (approval.type === 'elicitation') return { detail: {}, choices: [CANCEL], elsewhere: true }
  const explain = boardTool != null && boardToolNamedBy(approval) !== null
  const options = approval.options
  const placement = (option: (typeof options)[number]): 'safe' | 'proceed' =>
    explain ? boardToolPlacement(option) : option.intent === 'deny' || option.intent === 'cancel' ? 'safe' : 'proceed'
  const ordered = approvalChoiceOrder(options)
  const primary = ordered.filter((option) => placement(option) === 'proceed').at(-1)?.id
  return {
    detail: detailOf(approval),
    elsewhere: false,
    choices: ordered.map((option): ApprovalChoice => ({
      id: option.id,
      label: explain ? boardToolLabel(option, options, { session: boardTool.sessionOptionLabel, once: boardTool.onceOptionLabel }) : option.label,
      primary: option.id === primary,
      decision: option.intent === 'cancel' ? { type: 'cancel' } : { type: 'option', optionId: option.id },
      ...(option.description ? { title: option.description } : {}),
    })),
  }
}
