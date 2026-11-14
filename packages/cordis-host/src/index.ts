/**
 * `@harnessdesk/cordis-host` — the extension kernel.
 *
 * Wraps the real `@deepseek-ai/cordis` and exposes it as a `CapabilityRegistry`.
 * Nothing above this package imports Cordis, exactly as nothing above
 * `adapter-codex` imports Codex.
 */

export { ExtensionKernel, mergePermissions, type HarnessPlugin, type KernelLogger, type KernelOptions, type PluginManifest } from './kernel.js'
export { PermissionDenied, PermissionGate, hostAllowed, pathWithin } from './permissions.js'
export { ContributionStore } from './store.js'
export { canonicalRoot, canonicalScopeQuery } from './workspace-scope.js'
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
  escapingLink,
  listInstalled,
  loadInstalled,
  pluginsRoot,
  readInstalledManifest,
  redactCredentials,
  sanitise,
  uninstall,
  type InspectedPackage,
  type InstalledManifest,
  type InstalledPlugin,
} from './installer.js'
export { ConsentRecord, consentPath, manifestDigest, type ConsentCheck } from './plugin-consent.js'
export type { HarnessContext, HarnessPluginModule } from './context.js'
export { ALL_PERMISSIONS, type WorkspaceState } from './runtime.js'
export type {
  CommandSpec,
  ContextSpec,
  HookSpec,
  ToolSpec,
  UiSpec,
} from './services.js'
export {
  setCapabilityBroker,
  type CapabilityBroker,
  type CapabilityRequest,
  type HttpRequestInit,
  type HttpResponse,
  type ShellHost,
  type ShellResult,
} from './capabilities.js'
export { capabilityWorkMs, PluginCapabilityHost, readCapabilityRequest, type CapabilityLease } from './capability-host.js'
export {
  BrowserService,
  browserSettings,
  installedBrowsers,
  KEY_NAMES,
  namedKey,
  setBrowserEngine,
  setSystemHandOff,
  setBrowserFiles,
  pdfName,
  type BrowserFiles,
  placedBrowserEngine,
  handPageToSystem,
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
export { AgentsService, setAgentsEngine, type AgentsEngine, type AgentsScope, type AskAnswer, type AskInput } from './agents.js'
export {
  BrowserInvocations,
  BrowserScopes,
  browserPartition,
  currentBrowserIdentity,
  currentInvocationSignal,
  runBrowserInvocation,
  withBrowserIdentity,
  type BrowserIdentity,
} from './browser-scopes.js'
export { validateForgeArgs, type ForgeVerb, type ForgeAssociatedPullRequest, type ForgePush, type ForgeCreate, type ForgeUpdate, type ForgeMerge, type ForgeReview, type ForgeComment, type ForgeRecordQuery, type ForgeAttribute, type ForgeRequester, type ForgeGitEntry, type ForgeWriteResult, type ForgeThreadsQuery, type ForgeReviewThreads, type ForgeThreadSettle, type ForgeThreadSettled, FORGE_READS, ForgeService, setForgeEngine, type ForgeEngine, type ForgeIdentity, type ForgeScope, type ForgeSeat } from './forge.js'
export { IosService, type SimDevice } from './ios.js'
export type { IosAction, IosAppearance, IosCapability, IosFrame, IosKey, IosOrientation, IosSetup, PixelPoint, TimedPoint } from './ios-types.js'
export { AndroidService, type AndroidDevice } from './android.js'

export { IosEngine } from './ios-engine.js'
export { validateIosAction, iosActionWorkMs, iosInteractionTimeoutMs } from './ios-validation.js'
export { iosCallTimeoutMs, iosReplyTimeoutMs } from './ios-deadlines.js'
export { currentIosInvocation, withIosInvocation, withIosInputSignal } from './ios-invocation.js'
