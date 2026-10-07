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
