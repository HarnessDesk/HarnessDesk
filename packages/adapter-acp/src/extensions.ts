import type {
  ImportableConfig,
  McpServer,
  RuntimeCatalog,
  RuntimeExtensions,
  RuntimePlugin,
} from '@harnessdesk/protocol'

import type { CliMcp } from './mcp.js'

/**
 * A read-only `RuntimeExtensions` for ACP runtimes that have CLI-based MCP
 * listing but no extension store or import surface.
 *
 * Only `mcpServers` and `mcpLogin` produce useful answers; everything else is
 * either empty (for surfaces the host already guards with a null check) or
 * throws (for actions that need `extensionStore: true` to be reachable).
 */
export class AcpExtensions implements RuntimeExtensions {
  constructor(private readonly mcp: CliMcp) {}

  async catalog(): Promise<RuntimeCatalog> {
    return { plugins: [], marketplaces: [], loadErrors: [], featured: [] }
  }

  async detectImports(): Promise<readonly ImportableConfig[]> {
    return []
  }

  async importConfigs(): Promise<void> {
    throw new Error('This agent does not support importing configurations over ACP.')
  }

  async searchApps(): Promise<{ apps: RuntimePlugin[]; nextCursor?: string | null }> {
    return { apps: [], nextCursor: null }
  }

  async install(): Promise<void> {
    throw new Error('Plugin installation is not available for this agent.')
  }

  async uninstall(): Promise<void> {
    throw new Error('Plugin uninstallation is not available for this agent.')
  }

  async setEnabled(): Promise<void> {
    throw new Error('Plugin enable/disable is not available for this agent.')
  }

  async mcpServers(): Promise<readonly McpServer[]> {
    return this.mcp.list()
  }

  async mcpLogin(name: string): Promise<string> {
    return this.mcp.login(name)
  }

  async reloadMcp(): Promise<void> {
    // No-op: ACP agents reload their MCP configuration at process start.
  }
}
