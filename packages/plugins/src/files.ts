import type { HarnessContext, HarnessPlugin } from '@harnessdesk/cordis-host'

/**
 * Workspace file tools.
 *
 * Every path goes through `ctx.fs`, so the permission gate confines it to the
 * open workspace — a plugin cannot read outside it even by asking for an
 * absolute path.
 *
 * **Read-only, deliberately, and this is the file to argue with.** There is no
 * `write_file` here and no `workspace.write` in the manifest, because a write
 * projected to an agent is exactly the `fs` client capability HarnessDesk
 * declines from ACP — it would route around the backend's own approval
 * question and land outside the sandbox profile that governs that agent's own
 * writes. Every agent this app drives ships an edit tool already.
 *
 * What legitimately writes is a plugin acting for the *person* — a formatter,
 * a codemod — and that goes through `ctx.editor.applyEdits`, which takes both
 * the `editor` and `workspace.write` grants and opens the file it changed so
 * the change is seen rather than discovered. The full argument is in
 * `docs/decisions.md#writing-a-file-belongs-to-the-editor-plane`, and
 * `plugins.test.ts` fails if any built-in grows one.
 */

export const filesPlugin: HarnessPlugin = {
  manifest: {
    id: 'files',
    name: 'Workspace files',
    description: 'Read and list files inside the open workspace.',
    permissions: { workspace: { read: true, write: false } },
    configSchema: {
      type: 'object',
      properties: {
        maxBytes: {
          type: 'number',
          title: 'Maximum file size',
          description: 'Bytes returned before a file is truncated.',
        },
      },
    },
  },
  plugin: {
    name: 'files',
    inject: ['tools', 'fs'],
    apply(ctx: HarnessContext, config: { maxBytes?: number }) {
      ctx.tools.register({
        name: 'read_file',
        description: 'Read a UTF-8 file from the open workspace.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Path, relative to the workspace.' } },
          required: ['path'],
        },
        execute: async (args: { path: string }) => {
          const content = await ctx.fs.read(args.path)
          // Tool output competes for the model's context window; a whole large
          // file is rarely what was wanted. The limit is in bytes, as its name
          // says: compared with content.length, a file of three-byte characters
          // ran to three times it (#96).
          const limit = Math.max(1_000, config?.maxBytes ?? 64_000)
          const bytes = new TextEncoder().encode(content)
          if (bytes.length <= limit) return content
          // Never half a character: a UTF-8 continuation byte is 10xxxxxx, so
          // step back to the byte its character starts on.
          let end = limit
          while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
          return `${new TextDecoder().decode(bytes.subarray(0, end))}\n\n[truncated at ${limit} bytes]`
        },
      })

      ctx.tools.register({
        name: 'list_directory',
        description: 'List the entries of a directory in the open workspace.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Defaults to the workspace root.' } },
        },
        execute: async (args: { path?: string }) => {
          const entries = await ctx.fs.list(args?.path ?? '.')
          return entries
            .map((entry) => (entry.directory ? `${entry.name}/` : entry.name))
            .sort()
            .join('\n')
        },
      })
    },
  },
}
