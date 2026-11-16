import { OpenUnavailableError, type OpenAttempt } from './open-coordinator.js'

/** Gate one raw attempt behind host readiness/activity without losing its exact retirement owner. */
export const managedResumeAttempt = <T>(run: (start: () => Promise<T>) => Promise<T>, begin: () => OpenAttempt<T>): OpenAttempt<T> => {
  let retired = false, attempt: OpenAttempt<T> | null = null
  const result = run(async () => {
    if (retired) throw new OpenUnavailableError()
    attempt = begin()
    return attempt.result
  })
  return {
    result,
    ownsHandle: handle => attempt?.ownsHandle?.(handle) === true,
    retire: async state => {
      retired = true
      if (attempt) await attempt.retire(state)
    },
  }
}
