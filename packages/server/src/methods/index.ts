import type { HostMethodName, HostParams, HostResult } from '@harnessdesk/protocol'

import { accountMethods } from './accounts.js'
import { appMethods } from './app.js'
import type { HostContext, HostMethodTable } from './context.js'
import { credentialMethods } from './credentials.js'
import { flowMethods } from './flows.js'
import { gitMethods } from './git.js'
import { libraryMethods } from './library.js'
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
 * `agents/*` and the account/API-key verbs, `runtime-extensions` holds a
 * runtime's own plugin, MCP and import verbs; both name the prefixes they
 * take, and `runtimes.ts` leaves exactly those out.
 */
export const hostMethods: HostMethodTable = {
  ...appMethods,
  ...runtimeMethods,
  ...runtimeExtensionMethods,
  ...accountMethods,
  ...credentialMethods,
  ...usageMethods,
  ...libraryMethods,
  ...sessionMethods,
  ...turnMethods,
  ...workspaceMethods,
  ...terminalMethods,
  ...worktreeMethods,
  ...teamMethods,
  ...flowMethods,
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
  libraryMethods,
  sessionMethods,
  turnMethods,
  workspaceMethods,
  terminalMethods,
  worktreeMethods,
  teamMethods,
  flowMethods,
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
