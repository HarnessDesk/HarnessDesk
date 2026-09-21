import type { HostMethodName, HostParams, HostResult } from '@harnessdesk/protocol'

import { accountMethods } from './accounts.js'
import { agentMethods } from './agents.js'
import { appMethods } from './app.js'
import type { HostContext, HostMethodTable } from './context.js'
import { credentialMethods } from './credentials.js'
import { evidenceMethods } from './evidence.js'
import { provenanceMethods } from './provenance.js'
import { flowMethods } from './flows.js'
import { goalMethods } from './goals.js'
import { gitMethods } from './git.js'
import { insightMethods } from './insight.js'
import { libraryMethods } from './library.js'
import { laneMethods } from './lanes.js'
import { pluginMethods } from './plugins.js'
import { runtimeExtensionMethods } from './runtime-extensions.js'
import { runtimeMethods } from './runtimes.js'
import { sessionMethods } from './sessions.js'
import { teamMethods } from './team.js'
import { terminalMethods } from './terminals.js'
import { turnMethods } from './turns.js'
import { usageMethods } from './usage.js'
import { workspaceMethods } from './workspace.js'
import { worktreeMethods } from './worktrees.js'

export type { HostContext, HostMethodTable, MethodHandler } from './context.js'
export { TERMINAL_CHIP } from './plugins.js'

/**
 * Every wire method, by domain.
 *
 * `wire.ts` declares a method; `wire-validators.ts` checks its params off the
 * socket; one module here answers it. Two checks hold the third step. Each
 * module `satisfies MethodsUnder<its prefixes>`, so a method declared under
 * `git/` and not handled fails to compile in `git.ts` — the file where the
 * handler belongs. And the assignment below is typed by every declared
 * method name, so nothing declared can be left out of the whole, and a
 * handler whose result disagrees with its declaration does not compile
 * either. Which module a method lives in follows its prefix, with two seams
 * named for what they are rather than for the prefix: `accounts` holds
 * `acp/*` — the ACP registry — the account/API-key verbs, and
 * `runtime/installs*`; `runtime-extensions` holds a runtime's own plugin, MCP
 * and import verbs; both name the prefixes they take, and `runtimes.ts`
 * leaves exactly those out. `runtime/installs*` is named on the wire for what
 * it is about — which copy of one runtime's CLI answers — and answered in
 * `accounts.ts` because both verbs are gated on the writable registry that
 * module owns, and both share its install scan with `acp/update`.
 */
export const hostMethods: HostMethodTable = {
  ...appMethods,
  ...runtimeMethods,
  ...runtimeExtensionMethods,
  ...accountMethods,
  ...credentialMethods,
  ...usageMethods,
  ...insightMethods,
  ...libraryMethods,
  ...laneMethods,
  ...sessionMethods,
  ...turnMethods,
  ...workspaceMethods,
  ...terminalMethods,
  ...worktreeMethods,
  ...teamMethods,
  ...flowMethods,
  ...goalMethods,
  ...agentMethods,
  ...evidenceMethods,
  ...provenanceMethods,
  ...gitMethods,
  ...pluginMethods,
}

/**
 * The domain tables the assembled one was built from, for the test that
 * proves no method is answered twice — a spread cannot tell the compiler
 * that, so it is checked at run time, once.
 */
export const methodDomains: readonly Readonly<Partial<HostMethodTable>>[] = [
  appMethods,
  runtimeMethods,
  runtimeExtensionMethods,
  accountMethods,
  credentialMethods,
  usageMethods,
  insightMethods,
  libraryMethods,
  laneMethods,
  sessionMethods,
  turnMethods,
  workspaceMethods,
  terminalMethods,
  worktreeMethods,
  teamMethods,
  flowMethods,
  goalMethods,
  agentMethods,
  evidenceMethods,
  provenanceMethods,
  gitMethods,
  pluginMethods,
]

/**
 * Answers one request. `params` has already been validated against the same
 * table the handler's type reads from, which is what lets the handler be
 * typed exactly. The lookup is by own property so a name that is not a method
 * — `constructor`, say — is refused rather than found on the prototype.
 */
export const dispatch = async <M extends HostMethodName>(
  ctx: HostContext,
  method: M,
  params: HostParams<M>,
): Promise<HostResult<M>> => {
  if (!Object.hasOwn(hostMethods, method)) throw new Error(`Unknown method ${JSON.stringify(method)}`)
  return hostMethods[method](ctx, params)
}
