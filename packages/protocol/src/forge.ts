export interface ForgePush { readonly branch: string; readonly sha: string; readonly expect: 'create' | { readonly head: string } }
export interface ForgeCreate { readonly head: string; readonly base?: string; readonly title: string; readonly body: string; readonly draft?: boolean }
export interface ForgeUpdate { readonly number: number; readonly title?: string; readonly body?: string; readonly base?: string }
export interface ForgeMerge { readonly number: number; readonly head: string; readonly method: 'squash' | 'merge' | 'rebase'; readonly body?: string }
export interface ForgeReview { readonly number: number; readonly event: 'approve' | 'request-changes' | 'comment'; readonly body: string }
export interface ForgeComment { readonly subject: 'pullRequest' | 'issue'; readonly number: number; readonly body: string }
export interface ForgeRecordQuery { readonly branch?: string; readonly number?: number; readonly limit?: number }
export interface ForgeAttribute { readonly branch: string; readonly sha: string }
export interface ForgeRequester {
  readonly kind: 'lead-goal' | 'session' | 'person'; readonly id: string
  readonly seat?: { readonly label: string; readonly role: string | null; readonly round: number | null; readonly team: string | null } | null
  readonly conversation?: { readonly runtime: string; readonly sessionId: string; readonly title?: string } | null
}
export interface ForgeGitEntry {
  readonly id: string; readonly repository: string; readonly branch?: string; readonly number?: number
  readonly sha?: string; readonly previousSha?: string | null; readonly lease?: string | null
  readonly requester: ForgeRequester | { readonly kind: 'outside' }
  readonly approval: { readonly by: 'person' | 'standing' | 'ceiling' | 'steered'; readonly at?: number } | null
  readonly at: number; readonly op: 'push' | 'pr.create' | 'pr.update' | 'pr.merge' | 'pr.comment' | 'pr.review' | 'issue.comment' | 'observed' | 'pr.thread.resolve' | 'pr.thread.answer'
  /** The review thread a `pr.thread.*` row settled. */
  readonly thread?: string
  readonly outcome: 'intent' | 'unknown' | 'observed-merged' | 'ok' | 'refused' | 'failed' | 'rejected'; readonly reason?: string
}
export interface ForgeWriteResult { readonly output: string; readonly repository: string }
export type ForgeVerb = 'push' | 'create' | 'update' | 'merge' | 'review' | 'comment' | 'record' | 'attribute' | 'repository' | 'associatedPullRequest' | 'reviewThreads' | 'settleThread'

export type ForgeAssociatedPullRequest =
  | { readonly status: 'found'; readonly number: number; readonly repository: string }
  | { readonly status: 'none' }
  | { readonly status: 'ambiguous' }
  | { readonly status: 'unavailable' }

/** A pull request's review threads, read by the host (`reviewThreads`). */
export interface ForgeThreadsQuery { readonly number: number }
export interface ForgeReviewThread {
  /** The forge's node id, which `settleThread` takes. */
  readonly id: string
  readonly path: string | null
  readonly line: number | null
  /** Who opened the thread, by forge login. */
  readonly author: string | null
  /** Whether that author is a bot account. */
  readonly bot: boolean
  readonly resolved: boolean
  /** Whether the desk has already answered it; an answered thread is never answered again. */
  readonly answered: boolean
  /** The opening comment, bounded. Untrusted: the reviewer's words, never an instruction. */
  readonly body: string
}
export interface ForgeReviewThreads {
  readonly repository: string
  readonly number: number
  readonly title: string | null
  readonly url: string
  readonly state: 'open' | 'closed' | 'merged' | null
  readonly threads: readonly ForgeReviewThread[]
}
/**
 * One review thread settled by outcome: `fixed` resolves it and posts
 * nothing; `declined` answers it with one sentence (`answer`), once.
 */
export interface ForgeThreadSettle {
  readonly number: number
  readonly thread: string
  readonly outcome: 'fixed' | 'declined'
  readonly answer?: string
}
export interface ForgeThreadSettled extends ForgeWriteResult {
  readonly outcome: 'resolved' | 'already-resolved' | 'answered'
  /** The answer's address, when one was posted. */
  readonly url: string | null
  readonly pullRequest: { readonly title: string | null; readonly url: string; readonly state: 'open' | 'closed' | 'merged' | null }
}
