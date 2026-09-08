/**
 * `@harnessdesk/cordis-host` — the extension kernel.
 *
 * Wraps the real `@deepseek-ai/cordis` and exposes it as a `CapabilityRegistry`.
 * Nothing above this package imports Cordis, exactly as nothing above
 * `adapter-codex` imports Codex.
 */

export { ExtensionKernel, type HarnessPlugin, type KernelLogger, type KernelOptions, type PluginManifest } from './kernel.js'
export { PermissionDenied, PermissionGate, hostAllowed, pathWithin } from './permissions.js'
export { ContributionStore } from './store.js'
export {
  MANIFEST_FILENAME,
  ManifestError,
  describePermissions,
  parseManifest,
  readPermissions,
  type PluginPackage,
} from './manifest.js'
export {
  InstallError,
  install,
  inspect,
  listInstalled,
  loadInstalled,
  pluginsRoot,
  uninstall,
  type InstalledPlugin,
} from './installer.js'
export type { HarnessContext, HarnessPluginModule } from './context.js'
export { ALL_PERMISSIONS, type WorkspaceState } from './runtime.js'
export type {
  CommandSpec,
  ContextSpec,
  HookSpec,
  ToolSpec,
  UiSpec,
} from './services.js'
export type { HttpRequestInit, ShellResult } from './capabilities.js'
export {
  BrowserService,
  browserSettings,
  installedBrowsers,
  KEY_NAMES,
  namedKey,
  setBrowserEngine,
  setBrowserSettings,
  type BrowserEngine,
  type BrowserPage,
  type BrowserPlacement,
  type BrowserSettings,
  type CdpEvent,
  type CdpSender,
  type ConsoleEntry,
  type EmulateOptions,
  type NetworkEntry,
  type PointerOptions,
  type PointerTarget,
  type ReadPageOptions,
  type ScreenshotOptions,
  type WaitOptions,
} from './browser.js'
export { EditorService, setEditorEngine, type EditorEngine } from './editor.js'
export { TeamService, setTeamEngine, type TeamEngine, type TeamScope } from './team.js'
export { IosService, type SimDevice } from './ios.js'
export { AndroidService } from './android.js'
