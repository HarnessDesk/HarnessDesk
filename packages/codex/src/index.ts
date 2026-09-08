/**
 * `@harnessdesk/codex` — the transport layer for OpenAI Codex.
 *
 * Everything Codex-shaped that is *not* a translation lives here: finding the
 * binary, owning the process, framing NDJSON, and correlating JSON-RPC. The
 * adapter above imports this; nothing else should.
 */

export * from './errors.js'
export * from './discovery.js'
export * from './framing.js'
export * from './methods.js'
export * from './app-server.js'
export type * as CodexProtocol from './generated/index.js'
