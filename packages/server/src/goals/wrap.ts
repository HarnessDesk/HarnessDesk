import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { FindingReceipt, Goal, GoalReceipt, WrapChoices, WrapPreview } from '@harnessdesk/protocol'

import { Serial } from './assignments.js'

export interface WrapInput {
  goal: Goal
  cards: readonly { id: number; state: string }[]
  dependencies: readonly { id: string; state: string }[]
  busy: boolean
  flow: boolean
  pending: boolean
  seats: GoalReceipt['seats']
  evidence: GoalReceipt['evidence']
  answers: GoalReceipt['answers']
  lanes: GoalReceipt['lanes']
  citations: GoalReceipt['citations']
  gaps: GoalReceipt['gaps']
  revisions: GoalReceipt['revisions']
  /**
   * The findings the Goal owns, frozen: their event ids and the views they
   * fold to. Part of the stamp, so a finding raised, carried, posted or
   * overridden after a preview makes the wrap stale. Absent on a desk that
   * records none.
   */
  findings?: FindingReceipt
  /**
   * Publications of the Goal's findings that posting could not settle — an
   * uncertain send, a paused one — each said as a sentence. A wrap records
   * them as gaps only when the person says so (`WrapChoices.publicationGaps`).
   */
  publication?: readonly string[]
}

export type { WrapChoices } from '@harnessdesk/protocol'

export interface WrapPort {
  /** Refuses every change to the Goal's board until the answer is called: set before the board is read. */
  hold?(goal: string): () => void
  read(goal: string): Promise<WrapInput>
  stage(goal: string, receipt: GoalReceipt, stamp: string): Promise<void>
  closeSeats(goal: string, ids: readonly string[]): Promise<void>
  finish(goal: string, receipt: GoalReceipt): Promise<void>
}

export function wrapStamp(input: WrapInput, choices: WrapChoices): string {
  return createHash('sha256').update(JSON.stringify({ input, choices })).digest('hex')
}

export function previewWrap(input: WrapInput, choices: WrapChoices): WrapPreview {
  if (input.goal.state !== 'open') throw new Error('This Goal is already closing or wrapped.')
  if (input.busy || input.flow || input.pending) {
    throw new Error('Stop the running work and resolve waiting messages or approvals before wrapping.')
  }
  if (input.goal.dependsOn.some((id) => input.dependencies.find((dependency) => dependency.id === id)?.state !== 'wrapped')) {
    throw new Error('Wrap the Goals this one is waiting on first.')
  }
  if (!choices.summary.trim()) throw new Error('Say what finished before wrapping.')
  const resolutions = new Map(choices.cards.map((card) => [card.id, card]))
  if (resolutions.size !== choices.cards.length || choices.cards.length !== input.cards.length ||
      input.cards.some((card) => !resolutions.has(card.id))) {
    throw new Error('Review every card once before wrapping.')
  }
  if ((input.publication?.length ?? 0) > 0 && choices.publicationGaps !== 'record') {
    const count = input.publication!.length
    throw new Error(`${count === 1 ? 'One posting' : `${count} postings`} of this Goal's findings could not be confirmed on the pull request. Look at the pull request, then wrap recording ${count === 1 ? 'it' : 'them'} as a gap.`)
  }
  for (const card of input.cards) {
    const resolution = resolutions.get(card.id)!
    if ((resolution.resolution === 'dropped' || card.state !== 'done') && !resolution.reason?.trim()) {
      throw new Error(`Say why card ${card.id} is ${resolution.resolution}.`)
    }
  }
  return {
    stamp: wrapStamp(input, choices),
    receipt: structuredClone({
      version: 1,
      goal: input.goal.id,
      sentence: input.goal.sentence,
      summary: choices.summary.trim(),
      cards: choices.cards,
      seats: input.seats,
      evidence: input.evidence,
      answers: input.answers,
      lanes: input.lanes,
      citations: input.citations,
      revisions: input.revisions,
      gaps: input.gaps,
      ...(input.findings ? { findings: input.findings } : {}),
    }),
  }
}

export class Wraps {
  constructor(private readonly port: WrapPort, private readonly serial = new Serial()) {}

  commit(goal: string, stamp: string, choices: WrapChoices, id: string, at: number): Promise<GoalReceipt> {
    const approved = structuredClone(choices)
    return this.serial.run(async () => {
      // Nothing joins the board from here: what the receipt reviews is all there is to wrap.
      const release = this.port.hold?.(goal) ?? (() => {})
      try {
        return await this.#commit(goal, stamp, approved, id, at)
      } finally {
        release()
      }
    })
  }

  async #commit(goal: string, stamp: string, approved: WrapChoices, id: string, at: number): Promise<GoalReceipt> {
    const input = await this.port.read(goal)
    if (wrapStamp(input, approved) !== stamp) {
      throw new Error('This Goal changed while you reviewed its receipt. Review it again.')
    }
    const ready = previewWrap(input, approved)
    const receipt: GoalReceipt = { ...ready.receipt, id, wrappedAt: at }
    if (Buffer.byteLength(JSON.stringify(receipt), 'utf8') > 8 * 1024 * 1024) {
      throw new Error('This receipt is too large to store. Shorten the summary or card reasons and review it again.')
    }
    await this.port.stage(goal, receipt, stamp)
    await this.port.closeSeats(goal, receipt.seats)
    await this.port.finish(goal, receipt)
    return receipt
  }
}

const git = promisify(execFile)

/** Verifies a citation points at one literal regular file in a committed tree. */
export async function citationBlob(root: string, path: string, at: string): Promise<void> {
  const parts = path.split('/')
  if (!path || path.includes('\0') || path.includes('\\') || /^[A-Za-z]:/.test(path) ||
      parts.some((part) => part === '' || part === '.' || part === '..') ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(at)) {
    throw new Error('Choose a relative document path and its full committed revision.')
  }
  try {
    await git('git', ['cat-file', '-e', `${at}^{commit}`], { cwd: root })
    const result = await git('git', ['ls-tree', '-z', at, '--', `:(literal)${path}`], { cwd: root })
    const records = result.stdout.split('\0').filter(Boolean)
    if (records.length !== 1) throw new Error('Missing document')
    const tab = records[0]!.indexOf('\t')
    const [mode, kind] = records[0]!.slice(0, tab).split(' ')
    if (tab < 0 || records[0]!.slice(tab + 1) !== path || kind !== 'blob' ||
        (mode !== '100644' && mode !== '100755')) throw new Error('Not a regular document')
  } catch {
    throw new Error('That document is not available at the recorded revision. Restore the commit or choose another citation.')
  }
}
