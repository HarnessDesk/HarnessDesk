/**
 * What the shell does with an exception nothing caught.
 *
 * Electron's own answer is a modal error box, and the desk sat behind one
 * for as long as it took someone to notice (a helper's stdin answered EPIPE
 * after the helper had gone). Two reviewers of that fix pulled in opposite
 * directions: never block on a dialog — and never carry on as if nothing
 * happened after Node has lost its safe execution boundary. Both are right,
 * and they are different cases:
 *
 * - A broken pipe or a reset connection is a fact about some *other* process,
 *   whose supervisor already knows what to do. The shell carries on.
 * - Anything else is a state nobody can vouch for. The shell relaunches
 *   itself — the layout and the conversations are on disk and come back —
 *   unless it did that a moment ago, in which case relaunching would only
 *   loop, and it exits instead.
 *
 * The same rule covers a rejected promise nobody awaited. The first version
 * of this only logged those, on the reasoning that nothing was mid-flight on
 * the stack; two reviewers pointed out that this is not a safety boundary —
 * a promise callback routinely mutates state before it rejects, and Node's
 * own default for an unhandled rejection is to make it fatal. Installing a
 * listener silently downgrades that, so the listener has to answer for it.
 *
 * Pure but for the hooks `respondToCrash` is handed, so the whole lifecycle
 * is tested where Electron is not.
 */

/**
 * Errors that mean one thing only: something was written to a pipe that had
 * already gone. Each of these three is a *write* verdict — the stream is
 * closed, destroyed, or the reader is gone — and none of them can be reached
 * by code that was in the middle of changing this process's own state.
 *
 * `ECONNRESET`, `ECONNABORTED` and `EIO` were here too, and should not have
 * been: a reset connection is any socket in the process, and an I/O error is
 * any device. Neither proves a supervised child's stdin went away, so
 * excusing them let an unrelated failure be survived under a rule that
 * claims to survive only helper pipes. The four child-stdin sites listen for
 * their own errors at the boundary where the fact is actually known; this
 * list is the last resort behind them, and it is narrow on purpose.
 */
const PIPE_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'])

/** How recently a relaunch counts as "we just did that". */
export const RELAUNCH_LOOP_MS = 60_000

/**
 * `continue` for a pipe error; `relaunch` for anything else, unless the last
 * relaunch was within a minute — then `exit`, because the fault is in the
 * start-up path and a relaunch would meet it again.
 */
export const crashDecision = (error, { lastRelaunchAt = 0, now = Date.now() } = {}) => {
  const code = error && typeof error === 'object' ? String(error.code ?? '') : ''
  if (PIPE_CODES.has(code)) return 'continue'
  // `now >= lastRelaunchAt`, because a clock that went backwards between the
  // marker and the crash makes the difference negative — which is less than
  // the window, and would answer "we just relaunched" about a relaunch in
  // the future. A skewed clock must not turn a relaunch into an exit.
  if (lastRelaunchAt > 0 && now >= lastRelaunchAt && now - lastRelaunchAt < RELAUNCH_LOOP_MS) return 'exit'
  return 'relaunch'
}

/**
 * The whole answer to a fatal event, in one place both `uncaughtException`
 * and `unhandledRejection` go through.
 *
 * Every effect is a hook, so a test can watch the lifecycle rather than the
 * shell: what was recorded, what was logged, whether the marker was written,
 * and whether the process was relaunched, exited, or left alone. Returns the
 * decision it acted on.
 */
export const respondToCrash = (kind, error, hooks) => {
  const { record, log, readMarker, writeMarker, relaunch, exit, now = Date.now() } = hooks
  record?.(kind, error)
  let lastRelaunchAt = 0
  try {
    lastRelaunchAt = Number(readMarker?.()) || 0
  } catch {
    lastRelaunchAt = 0
  }
  const decision = crashDecision(error, { lastRelaunchAt, now })
  log?.(kind, error, decision)
  if (decision === 'continue') return decision
  if (decision === 'relaunch') {
    try {
      writeMarker?.(now)
    } catch {
      /* the marker is a courtesy; the relaunch is the point */
    }
    relaunch?.()
  }
  exit?.(1)
  return decision
}
