import type { CodexProtocol, ServerRequestResponder } from '@harnessdesk/codex'
import {
  approvalId as makeApprovalId,
  sessionId as makeSessionId,
  type AgentEvent,
  type Approval,
  type ApprovalDecision,
  type ApprovalId,
  type SessionId,
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
        if (request.params.mode === 'openai/userVerification') {
          this.#cancelVerification(request.params, responder)
          return true
        }
        const mapped = mapElicitationApproval(key, request.params)
        this.#enqueue(key, mapped.approval, mapped.raw, responder)
        return true
      }
      default:
        return false
    }
  }

  /**
   * An MCP server asking, through Codex, to verify that the person is who
   * they are (0.155.0). The answer is a signature over the request's
   * challenge, made with a key the client enrolled on the device
   * (`userVerification/enroll`). HarnessDesk enrols none, so nothing the
   * person could enter would verify anything: drawn as a form, which is what
   * this router did with every elicitation before, it would have asked them
   * for something no answer of theirs could satisfy.
   *
   * So it is cancelled — the answer Codex gives itself on every connection it
   * has not enabled verification for. 0.155.0 enables it only for its own
   * in-process terminal UI, so over `codex app-server` this is for a later
   * Codex that widens that. A refusal would come to the same thing: Codex
   * reads any error to a verification as a cancel and passes its message on
   * to no one. The tool call that asked now fails, and the person is told why
   * here, because nothing else would tell them.
   */
  #cancelVerification(
    params: Extract<
      CodexProtocol.v2.McpServerElicitationRequestParams,
      { readonly mode: 'openai/userVerification' }
    >,
    responder: ServerRequestResponder,
  ): void {
    responder.respond({
      action: 'cancel',
      content: null,
      _meta: null,
    } satisfies CodexProtocol.v2.McpServerElicitationRequestResponse)
    this.emit({
      type: 'notice',
      sessionId: makeSessionId(params.threadId),
      level: 'warning',
      message: `${params.serverName} asked to verify it is you ("${params.title}"). HarnessDesk cannot do that, so the request was cancelled.`,
    })
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
        if (decision.type !== 'option') return { permissions: {}, scope: 'turn' }
        const raw = entry.rawDecisions.get(decision.optionId) as
          | {
              grant: boolean
              scope?: 'turn' | 'session'
              permissions?: CodexProtocol.v2.RequestPermissionProfile
            }
          | undefined
        if (!raw?.grant) return { permissions: {}, scope: 'turn' }
        const requested = entry.approval.type === 'permission' ? entry.approval : null
        const permissions: CodexProtocol.v2.GrantedPermissionProfile = {
          ...(raw.permissions?.fileSystem
            ? { fileSystem: raw.permissions.fileSystem }
            : (requested?.filesystem?.length ?? 0) > 0
              ? {
                  fileSystem: {
                    read: [...(requested?.filesystem ?? [])],
                    write: [...(requested?.filesystem ?? [])],
                  },
                }
              : {}),
          ...(raw.permissions?.network
            ? { network: raw.permissions.network }
            : (requested?.network?.length ?? 0) > 0
              ? { network: { enabled: true } }
              : {}),
        }
        return {
          permissions,
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
   * Fails outstanding approvals for one session when that session is deleted or closed.
   */
  abandonSession(sessionId: SessionId, reason: string): void {
    const target = makeSessionId(String(sessionId))
    for (const [key, entry] of this.#pending.entries()) {
      if (entry.approval.sessionId === target) {
        this.#pending.delete(key)
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
