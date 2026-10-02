import { AsyncLocalStorage } from 'node:async_hooks'

/** The host-supplied checkout of a tool or context invocation, never a tool argument. */
const workspace = new AsyncLocalStorage<string | undefined>()

export const inShellWorkspace = <T>(root: string | undefined, body: () => T): T =>
  workspace.run(root, body)

export const currentShellWorkspace = (): string | undefined => workspace.getStore()
