/**
 * What deserves a macOS notification, decided away from Electron.
 *
 * The host pushes every wire notification through here; this module answers
 * with either nothing or a finished { title, body } — main.mjs only draws.
 * Kept free of Electron imports so `node --test` can exercise every rule.
 *
 * The rules, in one place:
 * - Nothing while the window is focused. A notification about the screen you
 *   are looking at is noise, and the app already shows everything in-pane.
 * - Four kinds, individually silenceable from Settings › Notifications:
 *   a finished turn, a failed turn, an approval, and "needs you" — the agent
 *   asking a question only a person can answer.
 * - An interrupted turn is never announced: the user did that themselves.
 */

/** The four kinds, with what the settings page should call them. */
export const SYSTEM_NOTIFICATION_KINDS = [
  {
    kind: 'turns',
    title: 'Finished turns',
    detail: 'An agent completed a turn while you were somewhere else.',
  },
  {
    kind: 'failures',
    title: 'Failures',
    detail: 'A turn ended badly — the error comes with it.',
  },
  {
    kind: 'approvals',
    title: 'Approvals',
    detail: 'An agent wants to run a command, edit files, or widen its sandbox.',
  },
  {
    kind: 'needsYou',
    title: 'Needs you',
    detail: 'An agent asked a question only you can answer.',
  },
]

/**
 * The cheap pre-check: whether this wire notification could ever become an
 * OS notification. The broadcaster fires for every push the host makes —
 * streaming deltas most of all — and the shell asks for preferences before
 * calling `decide`; this lets it skip that round-trip for the overwhelming
 * majority that could never notify. Lives here, beside `decide`, so the two
 * lists of interesting events cannot drift apart unnoticed — and `decide`
 * still enforces every rule itself, so a caller that forgets this check is
 * merely slower, never wrong.
 */
export const relevant = (notification) => {
  if (!notification || notification.method !== 'event') return false
  const type = notification.params?.event?.type
  return type === 'turn/completed' || type === 'approval/requested'
}

const LIMIT = 140

const trim = (text) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > LIMIT ? `${line.slice(0, LIMIT - 1)}…` : line
}

/** Whether one kind is on: everything defaults on, and the master wins. */
const wants = (prefs, kind) => {
  if (!prefs || typeof prefs !== 'object') return true
  if (prefs.enabled === false) return false
  return prefs[kind] !== false
}

/**
 * One wire notification in, one OS notification or null out.
 *
 * `context.agentName(runtime)` and `context.sessionTitle(runtime, sessionId)`
 * are lookups the caller owns — the host knows both; this module never holds
 * state of its own, which is what keeps every rule testable with two lines.
 */
export const decide = (notification, context) => {
  if (context.focused) return null
  if (!notification || notification.method !== 'event') return null
  const { runtime, event } = notification.params ?? {}
  if (!runtime || !event) return null
  const prefs = context.prefs
  const agent = context.agentName?.(runtime) ?? runtime

  if (event.type === 'turn/completed') {
    const status = event.turn?.status
    const sessionId = event.sessionId
    const title = context.sessionTitle?.(runtime, sessionId) ?? null
    if (status === 'completed' && wants(prefs, 'turns')) {
      return {
        kind: 'turns',
        runtime,
        sessionId,
        title: `${agent} finished`,
        body: trim(title ?? 'The turn is done.'),
      }
    }
    if (status === 'failed' && wants(prefs, 'failures')) {
      return {
        kind: 'failures',
        runtime,
        sessionId,
        title: `${agent} hit a problem`,
        body: trim(event.turn?.error?.message ?? title ?? 'The turn did not finish.'),
      }
    }
    // Interrupted is the user's own doing; announcing it would be an echo.
    return null
  }

  if (event.type === 'approval/requested') {
    const approval = event.approval ?? {}
    const sessionId = approval.sessionId
    const type = approval.type
    if (type === 'userInput' || type === 'elicitation') {
      if (!wants(prefs, 'needsYou')) return null
      const question =
        type === 'userInput'
          ? approval.questions?.[0]?.question
          : (approval.message ?? approval.reason)
      return {
        kind: 'needsYou',
        runtime,
        sessionId,
        title: `${agent} needs you`,
        body: trim(question ?? 'A question is waiting in the conversation.'),
      }
    }
    if (!wants(prefs, 'approvals')) return null
    const body =
      type === 'command'
        ? approval.command
        : type === 'fileChange'
          ? `Wants to change ${approval.changes?.length === 1 ? 'one file' : `${approval.changes?.length ?? 'some'} files`}.`
          : (approval.summary ?? 'An approval is waiting.')
    return {
      kind: 'approvals',
      runtime,
      sessionId,
      title: `${agent} is asking`,
      body: trim(body),
    }
  }

  return null
}
