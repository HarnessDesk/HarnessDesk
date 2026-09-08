/**
 * A plugin that uses ctx.editor the way a linter and a formatter would:
 * show a file, mark lines on it, rewrite one, and read back what the
 * person did. Every call has to leave this process to reach the plane.
 */
export const plugin = {
  name: 'editorish',
  inject: ['tools', 'editor'],
  apply(ctx) {
    ctx.tools.register({
      name: 'review',
      description: 'Shows a file and marks a line on it.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: async (args) => {
        await ctx.editor.open(String(args.path))
        await ctx.editor.decorate(String(args.path), [
          { fromLine: 2, severity: 'warning', message: 'this line is suspicious' },
        ])
        return 'marked'
      },
    })
    ctx.tools.register({
      name: 'format',
      description: 'Rewrites the second line.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: async (args) => {
        const { hash } = await ctx.editor.applyEdits(String(args.path), [
          { fromLine: 2, text: 'FORMATTED' },
        ])
        return hash
      },
    })
    ctx.tools.register({
      name: 'watch',
      description: 'Reports what the person has done since it last asked.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => JSON.stringify(await ctx.editor.events()),
    })
    ctx.tools.register({
      name: 'unmark',
      description: 'Clears the marks and stops showing the file.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: async (args) => {
        await ctx.editor.clearDecorations(String(args.path))
        await ctx.editor.close(String(args.path))
        return 'closed'
      },
    })
  },
}
