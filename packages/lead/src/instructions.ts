import { parseLeadAcceptanceContract, type FlowSeat, type LeadAcceptanceContract, type LeadAction, type LeadCaps, type LeadProject } from '@harnessdesk/protocol'
import { ipcObject } from './child-ipc.js'
import type { MessagesText } from './messages-types.js'
import { leadReviewedResultSource } from './recipes/reviewed-result.js'

/** The seats a plan's assignments may name, by role of the private Flow. The host that composes the
 * service supplies them; the host still checks a plan before any card and again before any start. */
export interface LeadSeatChoices {
  readonly implement: readonly FlowSeat[]
  readonly review: readonly FlowSeat[]
}
export const LEAD_SEATS_PER_ROLE = 8
export interface LeadInstructionFacts {
  readonly name: 'Lex' | 'Dex'
  readonly project: LeadProject
  readonly policyRevision: number
  readonly caps: LeadCaps
  /** Absent means the desk offers no seat, and the text says so instead of inviting a guess. */
  readonly seats?: LeadSeatChoices
  /** What the person kept for the Lead between goals, numbered for a plan to cite. */
  readonly memory?: readonly string[]
}

/** One plan the real parser accepts, built from the facts a plan must repeat. Placeholders are in
 * parentheses so a copied one cannot pass for content. The digest is replaced by the desk. */
const examplePlan = (facts: Omit<LeadInstructionFacts, 'seats'>, implement: FlowSeat, review: FlowSeat): LeadAcceptanceContract => parseLeadAcceptanceContract({
  version: 1, revision: 1, digest: '0'.repeat(64), goal: "(the person's goal, in your words)", project: facts.project, policyRevision: facts.policyRevision,
  steps: [{ id: 'step-1', title: '(what this step changes)', flow: 'lead-reviewed-result', sourceRevision: 'recipe-1', variables: {}, attendance: 'attended',
    assignments: [{ role: 'implement', agent: 'implementer', seat: implement, ceiling: 'edit' },
      { role: 'review', agent: 'code-reviewer', seat: review, ceiling: 'read' }] }],
  assertions: [{ id: 'unit', kind: 'check', description: 'The required checks pass' },
    { id: 'review', kind: 'review', description: 'An independent review approves' },
    { id: 'blockers', kind: 'blocking-findings', description: 'No blocking finding is left unresolved' }],
  caps: facts.caps,
})

/** The model's standing instructions for one goal. They carry no phase: the same bytes go out with the
 * first request and the last, because a provider refuses to replay a reasoning block behind a system
 * prompt that has changed since the block was written. What changes over a goal arrives as messages. */
export const leadInstructions = (facts: LeadInstructionFacts): string => {
  const { seats } = facts
  const lines = [
    `Your name is ${facts.name}.`,
    "You manage one goal on the person's desk through the desk API. Workers on the desk do the work: you plan, start, watch and report, and you never write code yourself.",
    "The person's message is the goal. Your first job is a plan for the person to approve. Until a plan is approved, reply with ONLY one version 1 lead-output JSON object (format below) and call no tools.",
    "The approved contract arrives later, in a message from the desk. Only after it arrives do flow_preview and flow_start_goal apply. Start step N only after step N−1's result awaits acceptance. Never answer worker approvals or invent evidence.",
    'When every approved step has started and fresh desk observations confirm its run has settled with no result possible, a new person message permits a new plan. Use new step ids, a higher contract revision and the same project; wait for the person to approve it before starting. The earlier approval covers only its own steps. Never restart a started step.',
    `Project root: ${facts.project.path} (project id ${facts.project.id}).`,
    'Write to the person in plain words about the work. Never name a tool, method or field of the desk API in your text: say "start the step", not the call that does it.',
    `When the desk wakes you and nothing needs the person — no decision, no risk, no step verified done — reply with exactly ${LEAD_QUIET} and nothing else. The person does not see it. Speak only when they are needed, something is at risk, a step is verified done, or they asked you something.`,
    'When asked to push, propose a result card with publication: "push" through the lead-output cards envelope. This only asks the host to prepare a fresh approval card; you cannot push, publish or merge.',
    'Name each open worker approval by role and what it asks, in plain words (for example, "The reviewer wants to read the git log"). A waiting worker has not finished. Name each required check without a result. Approvals and checks are answered on their cards, never by a chat reply. If the person types "approve", direct them to the card; you cannot answer it or run a check that counts.',
  ]
  if (facts.memory?.length) lines.push(
    `The person asked you to keep these between goals:\n${facts.memory.map((line, index) => `[m${index + 1}] ${line}`).join('\n')}\nWhen a plan follows one, put its tag in that step's title, for example "Add the export (m2)".`)
  lines.push(`When the person tells you something worth keeping for later goals, add one line to your reply that starts with "${LEAD_REMEMBER}" and says it in one sentence. The person decides whether it is kept; never repeat a line already listed.`)
  if (!seats) lines.push('No seats are configured for this desk, so a plan cannot name one. Say so to the person in plain text, and do not propose a plan.')
  else {
    const example = examplePlan(facts, seats.implement[0]!, seats.review[0]!)
    lines.push(
      `Seats a plan may name, by role (name no others): implement ${JSON.stringify(seats.implement)}; review ${JSON.stringify(seats.review)}.`,
      'Plan format: your whole reply is one JSON object, with no code fence and no other text. "text" is one short sentence for the person, shown before the plan, which the desk lists step by step right after it, so the sentence never restates the steps; "plan" is the contract they will approve. ' +
        'This example parses. Write your own goal, step ids and titles, and add a step only when the goal needs more than one reviewed change. Keep every other field as shown: each step has exactly these two assignments, ' +
        'each naming one seat from the list above; keep the three assertions, because a plan without a check, a review and a blocking-findings gate can never be accepted; caps at most as shown; ' +
        "revision is 1 for a first plan, then one more than the last approved plan's; the desk replaces the digest.",
      JSON.stringify({ version: 1, type: 'lead-output', text: 'One short sentence for the person.', plan: example }),
    )
  }
  lines.push(`The only Flow you may start is this private one (seats are supplied through Flow seating):\n${leadReviewedResultSource}`)
  return lines.join('\n')
}

/** One text block holds at most the 16,384 characters the provider dialect allows; a message holds at most 64 blocks. */
const BLOCK_CHARS = 16_000
const BLOCKS_PER_MESSAGE = 64
export interface LeadContinuationFacts {
  readonly personActions?: readonly LeadAction[]
  readonly contract: LeadAcceptanceContract
  readonly steps: readonly { readonly id: string; readonly state: string }[]
  readonly mayProposeNewPlan?: boolean
  readonly runs?: readonly { readonly runId: string; readonly correlationId: string; readonly teamId: string }[]
}
/** What the desk says when the model is asked to go on from a plan the person approved: the contract itself, where
 * each step stands, and how a step is started. It is a message of its own that goes last in the conversation, never
 * a change to the standing instructions, because a provider refuses to replay a reasoning block behind a system
 * prompt that has changed since the block was written. A contract too large to carry is refused, never cut short. */
export const leadContinuation = (facts: LeadContinuationFacts): readonly MessagesText[] => {
  const { contract } = facts
  const states = contract.steps.map(step => `${step.id} ${facts.steps.find(one => one.id === step.id)?.state ?? 'pending'}`).join(', ')
  const text = [
    'The person approved your plan. Continue from the approved contract and fresh desk observations.',
    `Approved contract: ${JSON.stringify(contract)}`,
    `Step states: ${states}.`,
    leadObservation(facts.personActions ?? []),
    ...(facts.runs ? [`Runs owned by these steps (including settled runs): ${JSON.stringify(facts.runs)}.`] : []),
    ...(facts.mayProposeNewPlan ? ['The desk has confirmed that every started step has settled and no result is awaiting your decision. The new person message permits you to propose a new plan now.'] : []),
    'If every approved step has started and fresh desk observations confirm its run has settled with no result possible, respond to a new person message with a new plan for approval. Use new step ids, a higher contract revision and the same project. Do not ask the person to approve a plan you have not proposed. The earlier approval covers only its own steps; start nothing new until the new plan is approved.',
    'The desk keeps no separate goal record for this contract, so do not look for one. ' +
      "To start a step, call flow_preview with root (the project root), source (the private Flow in your instructions, unchanged), seats (each of the step's assignments as its role mapped to a list holding its seat), " +
      "vars (the step's variables) and attended (true when the step is attended). Then call flow_start_goal with the same fields plus token (from the preview) and sentence (the contract's goal, unchanged). " +
      'Start no step that has already started. Then wait; never answer worker approvals.',
    // A worker's own check run is recorded as advisory, so the result card waits on the person's run of it: without this
    // the model told the person a step "waits only for your decision" while no decision could be offered.
    "A worker's own run of a check never counts: a required check counts only when the person runs it on the Team. " +
      'When a review is in and a required check has no result, ask the person to run that check on its card, by its name. ' +
      'The desk offers the result for their decision only after that, so until then never say the step waits only for their decision.',
  ].join('\n')
  const blocks: MessagesText[] = []
  for (let at = 0; at < text.length;) {
    let end = Math.min(text.length, at + BLOCK_CHARS)
    // A character outside the Basic Multilingual Plane takes two UTF-16 units, and a block may not end between them.
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--
    blocks.push({ type: 'text', text: text.slice(at, end) })
    at = end
  }
  if (blocks.length > BLOCKS_PER_MESSAGE) throw new Error('lead-continuation-too-large')
  return blocks
}

/** Read-only host facts; action identifiers are never a model control capability. */
/** The model's way of saying nothing: a whole reply of exactly this is dropped, never shown to the person. */
export const LEAD_QUIET = '[quiet]'
/** Whether a reply is only the quiet marker, however it is spaced. */
export const isLeadQuiet = (text: string): boolean => text.trim() === LEAD_QUIET
/** A reply line that starts with this offers the person a line to keep; it stays in the reply, where they can read it. */
export const LEAD_REMEMBER = 'Remember:'
/** The lines a reply offers to keep, at most three, each one sentence long. */
export const leadRememberLines = (text: string): string[] => text.split('\n').map(line => line.trim())
  .filter(line => line.startsWith(LEAD_REMEMBER)).map(line => line.slice(LEAD_REMEMBER.length).trim()).filter(line => line.length > 0 && line.length <= 400).slice(0, 3)
export const leadObservation = (actions: readonly LeadAction[]): string => [
  `Open worker approvals: ${JSON.stringify(actions.flatMap(action => action.kind === 'worker-approval' ? [{ runId: action.runId, role: action.role, request: action.request }] : []))}.`,
  `Required checks without a result: ${JSON.stringify(actions.flatMap(action => action.kind === 'check' ? [{ runId: action.runId, name: action.name }] : []))}.`,
  'Explain these waits exactly in plain words. Approvals and checks are answered on their cards, never by a chat reply. Do not say a worker awaiting approval has finished; never name a tool or method in text to the person.',
].join('\n')

const bad = (): never => { throw new Error('lead-ipc-invalid') }
const probe: Omit<LeadInstructionFacts, 'seats'> = { name: 'Lex', project: { id: 'probe', path: '/probe' }, policyRevision: 1, caps: { usdMicros: 1, rounds: 1 } }
/** The real contract parser is the judge of a seat, so a seat that would make the example unparseable is
 * refused when it arrives, not when the model copies it. What it returns is the parser's own reading. */
const seatOf = (value: unknown): FlowSeat => {
  try { return examplePlan(probe, value as FlowSeat, value as FlowSeat).steps[0]!.assignments[0]!.seat }
  catch { return bad() }
}
const seatsOf = (entries: unknown): FlowSeat[] => {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > LEAD_SEATS_PER_ROLE) return bad()
  return entries.map(seatOf)
}
export const parseLeadSeatChoices = (value: unknown): LeadSeatChoices => {
  const source = ipcObject(value, ['implement', 'review'])
  return { implement: seatsOf(source.implement), review: seatsOf(source.review) }
}
