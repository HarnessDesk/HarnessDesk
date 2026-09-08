import type { CodexProtocol, ServerRequestResponder } from '@harnessdesk/codex'
import {
  approvalId as makeApprovalId,
  sessionId as makeSessionId,
  type AgentEvent,
  type Approval,
  type ApprovalDecision,
  type ApprovalId,
} from '@harnessdesk/protocol'

import {
  mapCommandApproval,
  mapElicitationApproval,
  mapFileChangeApproval,
  mapPermissionApproval,
  mapUserInputApproval,
  toUserInputResponse,
} from './mapping/approvals.js'

/**
 * The approval queue.
 *
 * Codex asks by opening a JSON-RPC request and waiting. Something must answer,
 * or the turn stalls forever with no visible cause — so every path out of this
 * class ends in either a response or an explicit failure, including runtime
 * restart and shutdown.
 */

interface Entry {
  readonly approval: Approval
  readonly rawDecisions: ReadonlyMap<string, unknown>
  readonly kind: Approval['type']
  readonly responder: ServerRequestResponder
  answered: boolean
}

/** Look up the diff for a file-change approval, which arrives on the item. */
export type FileChangeLookup = (
  threadId: string,
  itemId: string,
) => readonly CodexProtocol.v2.FileUpdateChange[] | undefined

/** Look up the command a stdin approval's item started, which the request does not repeat. */
export type CommandLookup = (threadId: string, itemId: string) => string | undefined

export class ApprovalRouter {
  readonly #pending = new Map<string, Entry>()

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  /** Returns false when the request is not an approval this router owns. */
  handle(
    request: CodexProtocol.ServerRequest,
    responder: ServerRequestResponder,
    lookupChanges: FileChangeLookup,
    lookupCommand: CommandLookup = () => undefined,
  ): boolean {
    const key = String(request.id)

    switch (request.method) {
      case 'item/commandExecution/requestApproval': {
        const running =
          request.params.kind === 'writeStdin'
            ? lookupCommand(request.params.threadId, request.params.itemId)
            : undefined
        const mapped = mapCommandApproval(key, request.params, running)
        this.#enqueue(key, mapped.approval, mapped.raw, responder)
        return true
      }
      case 'item/fileChange/requestApproval': {
        const changes = lookupChanges(request.params.threadId, request.params.itemId) ?? []
        const mapped = mapFileChangeApproval(key, request.params, changes)
        this.#enqueue(key, mapped.approval, mapped.raw, responder)
        return true
      }
      case 'item/permissions/requestApproval': {
        const mapped = mapPermissionApproval(key, request.params)
        this.#enqueue(key, mapped.approval, mapped.raw, responder)
        return true
      }
      case 'item/tool/requestUserInput': {
        const mapped = mapUserInputApproval(key, request.params)
        this.#enqueue(key, mapped.approval, mapped.raw, responder)
        return true
      }
      case 'mcpServer/elicitation/request': {
        const mapped = mapElicitationApproval(key, request.params)
        this.#enqueue(key, mapped.approval, mapped.raw, responder)
        return true
      }
      default:
        return false
    }
  }

  #enqueue(
    key: string,
    approval: Approval,
    rawDecisions: ReadonlyMap<string, unknown>,
    responder: ServerRequestResponder,
  ): void {
    this.#pending.set(key, {
      approval,
      rawDecisions,
      kind: approval.type,
      responder,
      answered: false,
    })
    this.emit({ type: 'approval/requested', approval })
  }

  has(id: ApprovalId): boolean {
    return this.#pending.has(String(id))
  }

  /**
   * Answers a pending approval. Throws when the id is unknown, which is the
   * honest outcome — a stale dialog must not silently do nothing.
   */
  respond(id: ApprovalId, decision: ApprovalDecision): void {
    const key = String(id)
    const entry = this.#pending.get(key)
    if (!entry) {
      throw new Error(`No approval is pending with id ${key}`)
    }
    this.#pending.delete(key)
    if (entry.answered) return
    entry.answered = true

    entry.responder.respond(this.#toCodexResponse(entry, decision))
    this.emit({
      type: 'approval/resolved',
      sessionId: entry.approval.sessionId,
      approvalId: id,
      resolution: { outcome: 'decided', decision },
    })
  }

  #toCodexResponse(entry: Entry, decision: ApprovalDecision): unknown {
    switch (entry.kind) {
      case 'command':
      case 'fileChange': {
        if (decision.type !== 'option') return { decision: 'cancel' }
        const raw = entry.rawDecisions.get(decision.optionId)
        return { decision: raw ?? 'decline' }
      }

      case 'permission': {
        if (decision.type !== 'option') return { permissions: null, scope: 'turn' }
        const raw = entry.rawDecisions.get(decision.optionId) as
          | { grant: boolean; scope?: string }
          | undefined
        if (!raw?.grant) return { permissions: null, scope: 'turn' }
        const requested = entry.approval.type === 'permission' ? entry.approval : null
        return {
          permissions: {
            filesystem: requested?.filesystem ?? [],
            network: requested?.network ?? [],
          },
          scope: raw.scope === 'session' ? 'session' : 'turn',
        }
      }

      case 'userInput': {
        if (decision.type !== 'answers') return { answers: {} }
        return toUserInputResponse(
          entry.approval as Extract<Approval, { type: 'userInput' }>,
          decision.answers,
        )
      }

      case 'elicitation': {
        if (decision.type === 'content') {
          return { action: 'accept', content: decision.value, _meta: null }
        }
        return { action: decision.type === 'cancel' ? 'cancel' : 'decline', content: null, _meta: null }
      }
    }
  }

  /**
   * Fails everything outstanding. Called when the runtime restarts or shuts
   * down: the responder's socket is gone, but the UI still has dialogs open and
   * needs to be told they are dead.
   */
  abandonAll(reason: string): void {
    const entries = [...this.#pending.entries()]
    this.#pending.clear()
    for (const [, entry] of entries) {
      if (!entry.answered) {
        entry.answered = true
        entry.responder.fail(-32003, reason)
      }
      this.emit({
        type: 'approval/resolved',
        sessionId: entry.approval.sessionId,
        approvalId: makeApprovalId(String(entry.approval.id)),
        resolution: { outcome: 'abandoned', reason },
      })
    }
  }

  /** Outstanding approvals for one session, for replay to a late-joining client. */
  pendingFor(threadId: string): Approval[] {
    const target = makeSessionId(threadId)
    return [...this.#pending.values()]
      .filter((entry) => entry.approval.sessionId === target)
      .map((entry) => entry.approval)
  }

  get size(): number {
    return this.#pending.size
  }
}
