import { OpenUnavailableError, type OpenAttempt } from './open-coordinator.js'

/** Gate one raw attempt behind host readiness/activity without losing its exact retirement owner. */
export const managedResumeAttempt = <T>(run: (start: () => Promise<T>, check: () => void) => Promise<T>, begin: () => OpenAttempt<T>): OpenAttempt<T> => {
  let retired = false, attempt: OpenAttempt<T> | null = null
  const check = () => { if (retired) throw new OpenUnavailableError() }
  const result = run(async () => {
    check()
    attempt = begin()
    return attempt.result
  }, check)
  return {
    result,
    ownsHandle: handle => attempt?.ownsHandle?.(handle) === true,
    retire: async state => {
      retired = true
      if (attempt) await attempt.retire(state)
    },
  }
}
