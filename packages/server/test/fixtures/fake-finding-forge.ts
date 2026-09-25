import type { FindingAnchor, FindingPost } from '@harnessdesk/protocol'

import {
  APPEND_JOIN, chainOf, PublicationConflict, segmentsOf, sha256,
  type FindingForgePort, type ObservedTarget, type PublicationEntry, type SummaryReviewInput, type SummaryReviewLocation,
} from '../../src/findings/publication.js'

/**
 * A pull request's comments, held the way a forge holds them, behind the
 * findings publisher's port: no network, no `gh`. A test decides what each
 * send does — land, land and lose its answer, fail before anything lands,
 * land twice — and may hold one until it says so.
 */

export interface FakeComment {
  readonly id: number
  readonly kind: FindingPost['kind']
  body: string
  readonly inReplyTo: number | null
}

export type SendOutcome = 'ok' | 'lose' | 'fail' | 'duplicate'

export class FakeFindingForge implements FindingForgePort {
  repo = 'acme/widgets'
  head: string
  state: ObservedTarget['state'] = 'open'
  anchorOk = true
  readonly comments: FakeComment[] = []
  /** Every call, in order: `observe`, `anchor`, `find`, `send:<placement>`. */
  readonly calls: string[] = []
  /** Every send's operation key and body, in order. */
  readonly sends: { readonly key: string; readonly placement: string | null; readonly body: string }[] = []
  /** Decides what the next send does; `ok` when unset. */
  onSend: ((operation: PublicationEntry, body: string) => SendOutcome | Promise<SendOutcome>) | null = null
  /** Set, every read back throws this. */
  findFails: string | null = null
  /** The pull request's reviews, as the forge holds them: a closed round's one review lands here. */
  readonly reviews: { readonly id: number; readonly body: string; readonly head: string; readonly comments: readonly { readonly id: number; readonly body: string }[] }[] = []
  /** Every review sent, in order: exactly what the desk asked the forge to post. */
  readonly summaries: SummaryReviewInput[] = []
  /** Decides what the next review send does; `ok` when unset. */
  onSummary: ((input: SummaryReviewInput) => SendOutcome | Promise<SendOutcome>) | null = null
  #next = 100

  constructor(head: string) {
    this.head = head
  }

  #url(comment: FakeComment): string {
    return `https://github.com/${this.repo}/pull/7#${comment.kind === 'issue-comment' ? 'issuecomment' : 'discussion_r'}${comment.id}`
  }

  #post(operation: PublicationEntry, comment: FakeComment): FindingPost {
    return { repo: this.repo, pr: 7, comment: comment.id, kind: comment.kind, url: this.#url(comment), operation: operation.key }
  }

  async observeTarget(_project: string, pr: number): Promise<ObservedTarget> {
    this.calls.push('observe')
    return { repo: this.repo, number: pr, head: this.head, state: this.state }
  }

  async anchorable(_operation: PublicationEntry, _anchor: FindingAnchor): Promise<boolean> {
    this.calls.push('anchor')
    return this.anchorOk
  }

  async find(operation: PublicationEntry): Promise<readonly FindingPost[]> {
    this.calls.push('find')
    if (this.findFails) throw new Error(this.findFails)
    if (operation.placement === 'append') {
      const parent = 'parent' in operation ? operation.parent : null
      const comment = this.comments.find((one) => one.id === parent?.comment)
      if (!comment) return []
      const segments = segmentsOf(comment.body)
      const last = segments.at(-1) ?? ''
      return last.startsWith(operation.marker) && sha256(last) === operation.digest && chainOf(segments) === operation.wrote
        ? [this.#post(operation, comment)] : []
    }
    const kind = operation.placement === 'general' ? 'issue-comment' : 'review-comment'
    return this.comments
      .filter((one) => one.kind === kind && one.body.split('\n')[0] === operation.marker && sha256(one.body) === operation.digest)
      .map((one) => this.#post(operation, one))
  }

  #review(input: SummaryReviewInput, review: FakeFindingForge['reviews'][number]): SummaryReviewLocation {
    return {
      id: String(review.id), url: `https://github.com/${this.repo}/pull/${input.pr}#pullrequestreview-${review.id}`,
      comments: input.comments.map((wanted) => {
        const comment = review.comments.find((one) => one.body === wanted.body)!
        return { finding: wanted.finding, id: String(comment.id), url: `https://github.com/${this.repo}/pull/${input.pr}#discussion_r${comment.id}` }
      }),
    }
  }

  async publishSummary(input: SummaryReviewInput): Promise<SummaryReviewLocation> {
    this.calls.push('summary')
    this.summaries.push(input)
    const outcome = (await this.onSummary?.(input)) ?? 'ok'
    if (outcome === 'fail') throw new Error('connect ECONNREFUSED')
    const land = (): FakeFindingForge['reviews'][number] => {
      const review = { id: this.#next++, body: input.body, head: input.head, comments: input.comments.map((one) => ({ id: this.#next++, body: one.body })) }
      this.reviews.push(review)
      return review
    }
    const landed = land()
    if (outcome === 'duplicate') land()
    if (outcome === 'lose' || outcome === 'duplicate') throw new Error('socket hang up')
    return this.#review(input, landed)
  }

  async reconcileSummary(input: SummaryReviewInput): Promise<readonly SummaryReviewLocation[]> {
    this.calls.push('reconcile')
    if (this.findFails) throw new Error(this.findFails)
    return this.reviews
      .filter((one) => one.body.split('\n')[0] === `<!-- harnessdesk:finding-op ${input.key} -->` && sha256(one.body) === sha256(input.body) && one.head === input.head)
      .map((one) => this.#review(input, one))
  }

  async send(operation: PublicationEntry, body: string, _anchor: FindingAnchor | null): Promise<FindingPost> {
    this.calls.push(`send:${operation.placement}`)
    this.sends.push({ key: operation.key, placement: operation.placement, body })
    const outcome = (await this.onSend?.(operation, body)) ?? 'ok'
    if (outcome === 'fail') throw new Error('connect ECONNREFUSED')
    const parent = 'parent' in operation ? operation.parent : null
    let landed: FakeComment
    if (operation.placement === 'append') {
      const comment = this.comments.find((one) => one.id === parent?.comment)
      if (!comment) throw new Error('no such comment')
      if (chainOf(segmentsOf(comment.body)) !== operation.expected) throw new PublicationConflict('Someone changed this finding’s comment on the pull request.')
      comment.body = `${comment.body}${APPEND_JOIN}${body}`
      landed = comment
    } else {
      const kind = operation.placement === 'general' ? 'issue-comment' : 'review-comment'
      const make = (): FakeComment => {
        const comment = { id: this.#next++, kind, body, inReplyTo: operation.placement === 'reply' ? parent?.comment ?? null : null } as const
        this.comments.push({ ...comment })
        return this.comments.at(-1)!
      }
      landed = make()
      if (outcome === 'duplicate') make()
    }
    if (outcome === 'lose' || outcome === 'duplicate') throw new Error('socket hang up')
    return this.#post(operation, landed)
  }
}
