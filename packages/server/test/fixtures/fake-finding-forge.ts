import type { FindingAnchor, FindingPost } from '@harnessdesk/protocol'

import {
  APPEND_JOIN, chainOf, PublicationConflict, segmentsOf, sha256,
  type FindingForgePort, type ObservedTarget, type PublicationEntry,
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
