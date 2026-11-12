import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { LOCATIONS, locate } from './locations.js'
import { decodeMcpEntry, dialectFor, type McpServerSpec } from './mcp.js'

/** One server's declaration, as the library reads it, at a path the location table names. */
export type McpDeclarationLookup =
  | {
      readonly found: true
      readonly spec: McpServerSpec
      readonly scope: 'user' | 'project'
      /** The configuration file, resolved. */
      readonly file: string
    }
  | { readonly found: false; readonly detail: string }

/**
 * Find one MCP server by the identity the library shows: its name and the
 * file a copy of it sits in.
 *
 * `path` crossed a socket, so it is not trusted to name a file: it must be
 * exactly one of the configuration files the location table resolves to for
 * this home and project, and the table — never the caller — says which scope
 * and which dialect it is read in. The decode is the library's own
 * (`decodeMcpEntry`), so a test starts the same server the page lists.
 */
export const findMcpDeclaration = (
  name: string,
  path: string,
  options: { readonly home: string; readonly cwd?: string },
): McpDeclarationLookup => {
  const wanted = resolve(path)
  for (const [brand, table] of Object.entries(LOCATIONS)) {
    for (const spec of table.mcp) {
      const file = locate(spec, options.home, options.cwd)
      if (file === null || file !== wanted) continue
      const dialect = dialectFor(brand)
      if (dialect === null) continue
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        return { found: false, detail: 'The configuration file could not be read.' }
      }
      const decoded = decodeMcpEntry(text, spec.format, spec.key, name, dialect)
      if (decoded === null) {
        return { found: false, detail: 'This file does not declare that server in a form that can be read faithfully.' }
      }
      return { found: true, spec: decoded, scope: spec.scope, file }
    }
  }
  return { found: false, detail: 'That file is not one where any agent keeps MCP servers.' }
}
