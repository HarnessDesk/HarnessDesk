import type {
  FuzzyFileSearchParams,
  FuzzyFileSearchResponse,
  GetConversationSummaryParams,
  GetConversationSummaryResponse,
  GitDiffToRemoteParams,
  GitDiffToRemoteResponse,
  InitializeParams,
  InitializeResponse,
} from './generated/index.js'
import type {
  CancelLoginAccountParams,
  CancelLoginAccountResponse,
  CommandExecParams,
  ThreadBackgroundTerminalsListParams,
  ThreadBackgroundTerminalsListResponse,
  ThreadBackgroundTerminalsTerminateParams,
  ThreadBackgroundTerminalsTerminateResponse,
  CommandExecResizeParams,
  CommandExecResizeResponse,
  CommandExecResponse,
  CommandExecTerminateParams,
  CommandExecTerminateResponse,
  CommandExecWriteParams,
  CommandExecWriteResponse,
  CollaborationModeListParams,
  CollaborationModeListResponse,
  ConfigReadParams,
  ConfigReadResponse,
  ConfigRequirementsReadResponse,
  ExperimentalFeatureEnablementSetParams,
  ExperimentalFeatureEnablementSetResponse,
  ExperimentalFeatureListParams,
  ExperimentalFeatureListResponse,
  ExternalAgentConfigDetectParams,
  ExternalAgentConfigDetectResponse,
  ExternalAgentConfigImportParams,
  ExternalAgentConfigImportResponse,
  FsGetMetadataParams,
  FsGetMetadataResponse,
  FsReadDirectoryParams,
  FsReadDirectoryResponse,
  FsReadFileParams,
  FsReadFileResponse,
  FsUnwatchParams,
  FsUnwatchResponse,
  FsWatchParams,
  FsWatchResponse,
  FsWriteFileParams,
  FsWriteFileResponse,
  GetAccountParams,
  GetAccountResponse,
  GetAccountRateLimitsResponse,
  AppsListParams,
  AppsListResponse,
  ListMcpServerStatusParams,
  ListMcpServerStatusResponse,
  McpServerOauthLoginParams,
  McpServerOauthLoginResponse,
  PluginInstallParams,
  PluginInstallResponse,
  PluginListParams,
  PluginListResponse,
  PluginUninstallParams,
  PluginUninstallResponse,
  LoginAccountParams,
  LoginAccountResponse,
  LogoutAccountResponse,
  ModelListParams,
  ModelListResponse,
  PermissionProfileListParams,
  PermissionProfileListResponse,
  ReviewStartParams,
  ReviewStartResponse,
  HooksListParams,
  HooksListResponse,
  SkillsConfigWriteParams,
  SkillsConfigWriteResponse,
  SkillsListParams,
  SkillsListResponse,
  ThreadArchiveParams,
  ThreadArchiveResponse,
  ThreadCompactStartParams,
  ThreadCompactStartResponse,
  ThreadDeleteParams,
  ThreadDeleteResponse,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadGoalClearParams,
  ThreadGoalClearResponse,
  ThreadGoalGetParams,
  ThreadGoalGetResponse,
  ThreadGoalSetParams,
  ThreadGoalSetResponse,
  ThreadItemsListParams,
  ThreadItemsListResponse,
  ThreadListParams,
  ThreadListResponse,
  ThreadMemoryModeSetParams,
  ThreadMemoryModeSetResponse,
  ThreadRollbackParams,
  ThreadRollbackResponse,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadSearchParams,
  ThreadSearchResponse,
  ThreadSetNameParams,
  ThreadSetNameResponse,
  ThreadSettingsUpdateParams,
  ThreadSettingsUpdateResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadTurnsListParams,
  ThreadTurnsListResponse,
  ThreadUnarchiveParams,
  ThreadUnarchiveResponse,
  ThreadUnsubscribeParams,
  ThreadUnsubscribeResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from './generated/v2/index.js'

/**
 * The slice of the app-server surface HarnessDesk depends on.
 *
 * The generator emits params and response types but no method→response map, so
 * this table is the one hand-maintained artifact — and deliberately so: it is
 * the explicit record of our coupling to Codex. Every entry references generated
 * types, so a protocol change still surfaces as a compile error rather than a
 * runtime surprise.
 */
export interface CodexMethods {
  initialize: { params: InitializeParams; result: InitializeResponse }

  'thread/start': { params: ThreadStartParams; result: ThreadStartResponse }
  'thread/resume': { params: ThreadResumeParams; result: ThreadResumeResponse }
  'thread/fork': { params: ThreadForkParams; result: ThreadForkResponse }
  'thread/list': { params: ThreadListParams; result: ThreadListResponse }
  'thread/search': { params: ThreadSearchParams; result: ThreadSearchResponse }
  'thread/read': { params: ThreadReadParams; result: ThreadReadResponse }
  'thread/turns/list': { params: ThreadTurnsListParams; result: ThreadTurnsListResponse }
  'thread/items/list': { params: ThreadItemsListParams; result: ThreadItemsListResponse }
  'thread/archive': { params: ThreadArchiveParams; result: ThreadArchiveResponse }
  'thread/delete': { params: ThreadDeleteParams; result: ThreadDeleteResponse }
  'thread/unarchive': { params: ThreadUnarchiveParams; result: ThreadUnarchiveResponse }
  'thread/name/set': { params: ThreadSetNameParams; result: ThreadSetNameResponse }
  'thread/settings/update': {
    params: ThreadSettingsUpdateParams
    result: ThreadSettingsUpdateResponse
  }
  'thread/unsubscribe': { params: ThreadUnsubscribeParams; result: ThreadUnsubscribeResponse }
  'thread/compact/start': { params: ThreadCompactStartParams; result: ThreadCompactStartResponse }
  'thread/memoryMode/set': { params: ThreadMemoryModeSetParams; result: ThreadMemoryModeSetResponse }
  'thread/rollback': { params: ThreadRollbackParams; result: ThreadRollbackResponse }
  'thread/goal/set': { params: ThreadGoalSetParams; result: ThreadGoalSetResponse }
  'thread/goal/get': { params: ThreadGoalGetParams; result: ThreadGoalGetResponse }
  'thread/goal/clear': { params: ThreadGoalClearParams; result: ThreadGoalClearResponse }
  /**
   * The shell sessions a thread has left running. Behind `experimentalApi`,
   * which this client declares; without it the server refuses the method
   * rather than answering empty.
   */
  'thread/backgroundTerminals/list': {
    params: ThreadBackgroundTerminalsListParams
    result: ThreadBackgroundTerminalsListResponse
  }
  'thread/backgroundTerminals/terminate': {
    params: ThreadBackgroundTerminalsTerminateParams
    result: ThreadBackgroundTerminalsTerminateResponse
  }

  'turn/start': { params: TurnStartParams; result: TurnStartResponse }
  'turn/steer': { params: TurnSteerParams; result: TurnSteerResponse }
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResponse }

  'review/start': { params: ReviewStartParams; result: ReviewStartResponse }

  'model/list': { params: ModelListParams; result: ModelListResponse }
  'collaborationMode/list': {
    params: CollaborationModeListParams
    result: CollaborationModeListResponse
  }
  'permissionProfile/list': {
    params: PermissionProfileListParams
    result: PermissionProfileListResponse
  }
  'experimentalFeature/list': {
    params: ExperimentalFeatureListParams
    result: ExperimentalFeatureListResponse
  }
  'experimentalFeature/enablement/set': {
    params: ExperimentalFeatureEnablementSetParams
    result: ExperimentalFeatureEnablementSetResponse
  }

  'account/read': { params: GetAccountParams; result: GetAccountResponse }
  'account/login/start': { params: LoginAccountParams; result: LoginAccountResponse }
  'account/login/cancel': { params: CancelLoginAccountParams; result: CancelLoginAccountResponse }
  'account/logout': { params: undefined; result: LogoutAccountResponse }
  'account/rateLimits/read': { params: undefined; result: GetAccountRateLimitsResponse }

  'config/read': { params: ConfigReadParams; result: ConfigReadResponse }
  'configRequirements/read': { params: undefined; result: ConfigRequirementsReadResponse }
  'externalAgentConfig/detect': {
    params: ExternalAgentConfigDetectParams
    result: ExternalAgentConfigDetectResponse
  }
  'externalAgentConfig/import': {
    params: ExternalAgentConfigImportParams
    result: ExternalAgentConfigImportResponse
  }
  'skills/list': { params: SkillsListParams; result: SkillsListResponse }
  'skills/config/write': { params: SkillsConfigWriteParams; result: SkillsConfigWriteResponse }
  'hooks/list': { params: HooksListParams; result: HooksListResponse }
  'mcpServerStatus/list': {
    params: ListMcpServerStatusParams
    result: ListMcpServerStatusResponse
  }
  'mcpServer/oauth/login': { params: McpServerOauthLoginParams; result: McpServerOauthLoginResponse }
  'config/mcpServer/reload': { params: undefined; result: Record<string, never> }
  'plugin/list': { params: PluginListParams; result: PluginListResponse }
  'plugin/install': { params: PluginInstallParams; result: PluginInstallResponse }
  'plugin/uninstall': { params: PluginUninstallParams; result: PluginUninstallResponse }
  'app/list': { params: AppsListParams; result: AppsListResponse }

  'command/exec': { params: CommandExecParams; result: CommandExecResponse }
  'command/exec/write': { params: CommandExecWriteParams; result: CommandExecWriteResponse }
  'command/exec/resize': { params: CommandExecResizeParams; result: CommandExecResizeResponse }
  'command/exec/terminate': {
    params: CommandExecTerminateParams
    result: CommandExecTerminateResponse
  }

  fuzzyFileSearch: { params: FuzzyFileSearchParams; result: FuzzyFileSearchResponse }
  'fs/readFile': { params: FsReadFileParams; result: FsReadFileResponse }
  'fs/writeFile': { params: FsWriteFileParams; result: FsWriteFileResponse }
  'fs/readDirectory': { params: FsReadDirectoryParams; result: FsReadDirectoryResponse }
  'fs/getMetadata': { params: FsGetMetadataParams; result: FsGetMetadataResponse }
  'fs/watch': { params: FsWatchParams; result: FsWatchResponse }
  'fs/unwatch': { params: FsUnwatchParams; result: FsUnwatchResponse }
  gitDiffToRemote: { params: GitDiffToRemoteParams; result: GitDiffToRemoteResponse }
  getConversationSummary: {
    params: GetConversationSummaryParams
    result: GetConversationSummaryResponse
  }
}

export type CodexMethod = keyof CodexMethods
export type CodexParams<M extends CodexMethod> = CodexMethods[M]['params']
export type CodexResult<M extends CodexMethod> = CodexMethods[M]['result']
