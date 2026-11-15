import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

// Synthetic historical fixture only; final Host must validate it before use.
export function makeLedger(project) {
  if (!isAbsolute(project) || /[\u0000-\u001f\u007f]/.test(project)) throw new Error('invalid synthetic project')
  const stop = (comment, state, createdAt) => {
    const key = { project, trigger: 'fixture-trigger', repository: 'example.invalid/fixture', comment }
    const id = `u-${createHash('sha256').update(JSON.stringify([key.project, key.trigger, key.repository, key.comment])).digest('hex')}`
    return { version: 1, id, key, bodyDigest: createHash('sha256').update(`synthetic-comment-${comment}`).digest('hex'), threadId: `fixture-thread-${comment}`,
      thread: { kind: 'issue', number: Number(comment) }, author: 'fixture-user', excerpt: '@dex stop this work',
      url: `https://example.invalid/fixture/issues/${comment}#issuecomment-${comment}`, createdAt, state, decisionId: null,
      goals: [], firings: [], queuedTargets: [], runTargets: [], interruptTargets: [], leadRunTargets: [], leadPlanTarget: null,
      receipts: { queued: [], runs: [], interrupts: [], leadRuns: [], leadPlan: false } }
  }
  return { version: 2, decisions: [], threads: [], pendingThreads: [], stopIntents: [stop('101','inFlight',1), stop('102','unconfirmed',2), stop('103','reviewed',3)], modes: {}, assessed: { day: '', count: 0 } }
}
