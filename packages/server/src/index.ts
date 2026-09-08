/** `@harnessdesk/server` — the loopback host. */

export { Host, type AccountFactory, type HostOptions } from './host.js'
export {
  AccountSlots,
  accountIdentity,
  codexPrimaryHome,
  linkHome,
  slotHasCredential,
  slotHome,
  type AccountSlot,
} from './accounts.js'
export { serve, type RunningServer, type ServeOptions } from './server.js'
export { SessionRegistry, type SessionRecord } from './registry.js'
export { StateStore, defaultStateDir, type AppState, type WorkspaceRecord } from './state.js'
export { Logger, type LogLevel, type LogRecord, type LoggerOptions } from './log.js'
export { LocalFiles, asText, browseDirectories, confine, describeWorkspace, fuzzyScore, searchFiles } from './workspace.js'
export * as git from './git.js'
export * as worktree from './worktree.js'
export { createDefaultHost, loadBuiltinPlugins } from './bootstrap.js'
export { recordCrash } from './crash.js'
export { TEMPLATE_BRIDGES } from './agent-registry.js'
export { AcpRegistry, ACP_REGISTRY_URL, registryPlatform, type AcpRegistryOptions } from './acp-registry.js'
export { UpdateChecker, isNewer, upgradeCommand, type UpdateCheckerOptions } from './updates.js'
export type { ExtensionHost, ModelRouteRecord } from './host.js'
export { hostMethods, type HostContext, type HostMethodTable, type MethodHandler } from './methods/index.js'
export { CatalogRefresher, DEFAULT_REFRESH_INTERVAL_MS, type CatalogRefresherOptions, type RefreshResult } from './catalog-refresher.js'
