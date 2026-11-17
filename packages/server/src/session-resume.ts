import { OpenUnavailableError } from './open-coordinator.js'
import {
  isFolderGone,
  isSessionGone,
  type AgentRuntime,
  type AgentSession,
  type SessionId,
  type SessionOptions,
} from '@harnessdesk/protocol'

/** Retry an omitted listing row only on the Seat's durable checkout. */
export const resumeSeatSession = async (
  runtime: AgentRuntime,
  id: SessionId,
  options: Partial<SessionOptions>,
  recordedCwd: string | undefined,
): Promise<AgentSession> => {
  try {
    return await runtime.resumeSession(id, options)
  } catch (error) {
    if (!recordedCwd || !(error instanceof Error) || !isSessionGone(error) || !/does not list conversation/.test(error.message)) {
      throw error
    }
    try {
      return await runtime.resumeSession(id, { ...options, knownCwd: recordedCwd })
    } catch (retryError) {
      // A missing Seat folder is the actionable news. Other retry failures
      // retain the original listing refusal, as the direct resume always did.
      if (isFolderGone(retryError)) throw retryError
      throw error
    }
  }
}

/** Keep an exact adapter attempt behind asynchronous host preparation. */
export const ownedResumePreparation = <T, O, P = T>(
  prepare: (start: (options: O) => Promise<T>, check: () => void) => Promise<P>,
  begin: (options: O) => import('./open-coordinator.js').OpenAttempt<T>,
): import('./open-coordinator.js').OpenAttempt<P> => {
  let retired = false
  const attempts: import('./open-coordinator.js').OpenAttempt<T>[] = []
  const check = () => { if (retired) throw new OpenUnavailableError() }
  const result = prepare(options => {
    check()
    const attempt = begin(options)
    attempts.push(attempt)
    return attempt.result
  }, check).then(value => { check(); return value })
  return { result, retire: async state => {
    retired = true
    await Promise.all([result.then(() => {}, () => {}), ...attempts.map(attempt => attempt.retire(state))])
  } }
}
