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
          title: 'Read limit, in bytes',
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
          // ran to three times it (#96). A whole number, since it indexes the
          // bytes below: a fraction stepped past the check that keeps a
          // character whole (review of #190, round 1).
          // A number, or the default. Nothing checks a setting's type on its way in over `plugin/configure`, and
          // `Math.max(1_000, 'abc')` is NaN, which cut every file to nothing (review of #190, round 2).
          const asked = config?.maxBytes
          const limit = Math.trunc(Math.max(1_000, typeof asked === 'number' && Number.isFinite(asked) ? asked : 64_000))
          // Only what could be kept is encoded. A file longer than the limit in
          // UTF-16 units is longer in bytes too, since each unit is at least
          // one, so its first limit + 1 units hold the cut; encoding all of a
          // large file only to measure it copied it whole (review, round 1).
          const bytes = new TextEncoder().encode(content.length > limit ? content.slice(0, limit + 1) : content)
          if (bytes.length <= limit) return content
          // Never half a character: a UTF-8 continuation byte is 10xxxxxx, so
          // step back to the byte its character starts on.
          let end = limit
          while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
          // `ignoreBOM`, or the decoder drops a byte-order mark the file starts
          // with, which a file short enough to come back whole keeps (review,
          // round 1). The note says where the cut is: the limit, or the last
          // whole character short of it (review, round 2).
          return `${new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, end))}\n\n[truncated at ${end} bytes]`
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
