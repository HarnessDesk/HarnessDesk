import { laneEnvironmentOf } from '@harnessdesk/protocol'
import type { CodexProtocol } from '@harnessdesk/codex'

type Config = NonNullable<CodexProtocol.v2.ThreadStartParams['config']>

export const codexEnvironmentConfig = (
  config: Config,
  environment: Readonly<Record<string, string>>,
): Config => ({
  ...config,
  'shell_environment_policy.set': { ...laneEnvironmentOf(environment) },
})
