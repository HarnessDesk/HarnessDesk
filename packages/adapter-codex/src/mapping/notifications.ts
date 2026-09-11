import {
  itemId,
  sessionId,
  turnId,
  type AgentEvent,
  type RateLimits,
  type RuntimeId,
  type UsageWindow,
} from '@harnessdesk/protocol'
import type { CodexProtocol } from '@harnessdesk/codex'

import { mapTurnError } from './errors.js'
import { mapItem, mapFileChange } from './items.js'
import { CODEX_RUNTIME_ID, mapGoal, mapPlanSteps, mapStatus, mapTurn, mapUsage } from './session.js'

/**
 * `ServerNotification` → `AgentEvent`.
 *
 * Returns an array because a few Codex notifications carry more than one fact,
 * and an empty array because plenty carry none we model — MCP startup chatter,
 * remote-control status, realtime audio. Dropping those here keeps the noise out
 * of the UI's event stream rather than making every consumer filter.
 */

type ServerNotification = CodexProtocol.ServerNotification

const windowLabel = (minutes: number | null): string => {
  if (minutes === null) return 'Usage'
  if (minutes % 10080 === 0) return minutes === 10080 ? 'Weekly' : `${minutes / 10080}-week`
  if (minutes % 1440 === 0) return minutes === 1440 ? 'Daily' : `${minutes / 1440}-day`
  if (minutes % 60 === 0) return `${minutes / 60}-hour`
  return `${minutes}-minute`
}

/** Codex stamps reset times in epoch seconds; the protocol speaks milliseconds. */
const resetMillis = (at: number | null): number | null =>
  at === null ? null : at < 1e12 ? at * 1000 : at

const mapWindow = (window: CodexProtocol.v2.RateLimitWindow | null): UsageWindow | null =>
  window
    ? {
        label: windowLabel(window.windowDurationMins),
        usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
        windowMinutes: window.windowDurationMins,
        resetsAt: resetMillis(window.resetsAt),
      }
    : null

/**
 * A balance that is there, as a number. Codex sends it as a string, and read
 * by truthiness only its being a string let `"0"` through: a numeric `0` from
 * a changed payload or a fixture was dropped before `describeLimits` saw it,
 * which is #85 one layer down (#184). What isn't a finite number is none,
 * here at the boundary: `describeLimits` refused a NaN, but the usage report
 * passed it on, and a card read "NaN credits" (review of #207, round 1).
 */
const balanceOf = (value: string | number | null | undefined): number | null => {
  const read = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : null
  return read !== null && Number.isFinite(read) ? read : null
}

export const mapRateLimits = (
  snapshot: CodexProtocol.v2.RateLimitSnapshot,
): RateLimits => ({
  hasCredits: snapshot.credits?.hasCredits,
  unlimited: snapshot.credits?.unlimited,
  balance: balanceOf(snapshot.credits?.balance),
  planType: snapshot.planType,
  windows: [mapWindow(snapshot.primary), mapWindow(snapshot.secondary)].filter(
    (window): window is UsageWindow => window !== null,
  ),
  reached: snapshot.rateLimitReachedType,
})

export const mapNotification = (
  notification: ServerNotification,
  runtime: RuntimeId = CODEX_RUNTIME_ID,
): AgentEvent[] => {
  switch (notification.method) {
    case 'thread/status/changed':
      return [
        {
          type: 'session/status',
          sessionId: sessionId(notification.params.threadId),
          status: mapStatus(notification.params.status),
        },
      ]

    case 'thread/name/updated':
      return [
        {
          type: 'session/title',
          sessionId: sessionId(notification.params.threadId),
          title: notification.params.threadName ?? null,
        },
      ]

    case 'thread/goal/updated':
      return [
        {
          type: 'session/goal',
          sessionId: sessionId(notification.params.threadId),
          goal: mapGoal(notification.params.goal),
        },
      ]

    case 'thread/goal/cleared':
      return [
        {
          type: 'session/goal',
          sessionId: sessionId(notification.params.threadId),
          goal: null,
        },
      ]

    case 'thread/closed':
      return [{ type: 'session/closed', sessionId: sessionId(notification.params.threadId) }]

    case 'turn/started':
      return [
        {
          type: 'turn/started',
          sessionId: sessionId(notification.params.threadId),
          turn: mapTurn(notification.params.turn),
        },
      ]

    case 'turn/completed': {
      const session = sessionId(notification.params.threadId)
      const turn = mapTurn(notification.params.turn)
      const events: AgentEvent[] = [{ type: 'turn/completed', sessionId: session, turn }]
      // A failed turn carries its error inline; surface it as a first-class
      // error too so the UI can react without inspecting every turn.
      if (notification.params.turn.error) {
        events.push({
          type: 'error',
          sessionId: session,
          error: mapTurnError(notification.params.turn.error),
        })
      }
      return events
    }

    case 'turn/diff/updated':
      return [
        {
          type: 'turn/diff',
          sessionId: sessionId(notification.params.threadId),
          turnId: turnId(notification.params.turnId),
          diff: notification.params.diff,
        },
      ]

    case 'turn/plan/updated':
      return [
        {
          type: 'turn/plan',
          sessionId: sessionId(notification.params.threadId),
          turnId: turnId(notification.params.turnId),
          steps: mapPlanSteps(notification.params.plan),
        },
      ]

    case 'item/started':
      return [
        {
          type: 'item/started',
          sessionId: sessionId(notification.params.threadId),
          turnId: turnId(notification.params.turnId),
          // The one timestamp Codex gives an item; it is already in milliseconds.
          item: { ...mapItem(notification.params.item), startedAt: notification.params.startedAtMs },
        },
      ]

    case 'item/completed':
      return [
        {
          type: 'item/completed',
          sessionId: sessionId(notification.params.threadId),
          turnId: turnId(notification.params.turnId),
          item: mapItem(notification.params.item),
        },
      ]

    case 'item/agentMessage/delta':
      return [
        delta(notification.params, { kind: 'assistantText', text: notification.params.delta }),
      ]

    case 'item/plan/delta':
      return [delta(notification.params, { kind: 'planText', text: notification.params.delta })]

    case 'item/reasoning/summaryTextDelta':
      return [
        delta(notification.params, {
          kind: 'reasoningSummary',
          index: notification.params.summaryIndex,
          text: notification.params.delta,
        }),
      ]

    case 'item/reasoning/summaryPartAdded':
      return [
        delta(notification.params, {
          kind: 'reasoningSummaryPart',
          index: notification.params.summaryIndex,
        }),
      ]

    case 'item/reasoning/textDelta':
      return [
        delta(notification.params, {
          kind: 'reasoningText',
          index: notification.params.contentIndex,
          text: notification.params.delta,
        }),
      ]

    case 'item/commandExecution/outputDelta':
      return [
        delta(notification.params, {
          kind: 'commandOutput',
          // Codex aggregates stdout and stderr into one stream before sending.
          stream: 'stdout',
          chunk: notification.params.delta,
        }),
      ]

    case 'item/fileChange/patchUpdated':
      return [
        delta(notification.params, {
          kind: 'fileChangePatch',
          changes: notification.params.changes.map(mapFileChange),
        }),
      ]

    case 'thread/tokenUsage/updated':
      return [
        {
          type: 'usage/updated',
          sessionId: sessionId(notification.params.threadId),
          usage: mapUsage(notification.params.tokenUsage),
        },
      ]

    case 'account/rateLimits/updated':
      return [
        {
          type: 'limits/updated',
          runtime,
          limits: mapRateLimits(notification.params.rateLimits),
        },
      ]

    case 'account/login/completed':
      return [
        {
          type: 'account/loginCompleted',
          runtime,
          loginId: notification.params.loginId,
          success: notification.params.success,
          error: notification.params.error,
        },
      ]

    case 'account/updated':
      // Carries only the auth mode and plan; the email and the forced method
      // need a read anyway, so the event says "changed" and nothing more.
      return [{ type: 'account/changed', runtime }]

    case 'error':
      return [
        {
          type: 'error',
          sessionId: sessionId(notification.params.threadId),
          error: mapTurnError(notification.params.error, notification.params.willRetry),
        },
      ]

    case 'warning':
    case 'guardianWarning':
      return [
        {
          type: 'notice',
          ...(notification.params.threadId
            ? { sessionId: sessionId(notification.params.threadId) }
            : {}),
          level: 'warning',
          message: notification.params.message,
        },
      ]

    case 'configWarning':
      return [
        {
          type: 'notice',
          level: 'warning',
          message: joinDetail(notification.params.summary, notification.params.details),
        },
      ]

    case 'deprecationNotice':
      return [
        {
          type: 'notice',
          level: 'info',
          message: joinDetail(notification.params.summary, notification.params.details),
        },
      ]

    case 'thread/compacted':
      return [
        {
          type: 'notice',
          sessionId: sessionId(notification.params.threadId),
          level: 'info',
          message: 'Context was compacted to make room for more of this conversation.',
        },
      ]

    case 'model/rerouted':
      return [
        {
          type: 'notice',
          sessionId: sessionId(notification.params.threadId),
          level: 'info',
          message: `Codex switched from ${notification.params.fromModel} to ${notification.params.toModel}.`,
        },
      ]

    default:
      // Deliberately unmodelled: MCP startup status, remote-control state,
      // realtime audio, fuzzy-file-search sessions, Windows sandbox setup.
      // These are either surfaced through dedicated calls or irrelevant here.
      return []
  }
}

const joinDetail = (summary: string, details: string | null): string =>
  details ? `${summary} — ${details}` : summary

const delta = (
  params: { threadId: string; turnId: string; itemId: string },
  payload: Extract<AgentEvent, { type: 'item/delta' }>['delta'],
): AgentEvent => ({
  type: 'item/delta',
  sessionId: sessionId(params.threadId),
  turnId: turnId(params.turnId),
  itemId: itemId(params.itemId),
  delta: payload,
})
