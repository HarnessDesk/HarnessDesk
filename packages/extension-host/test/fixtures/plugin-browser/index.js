/** A plugin that uses ctx.browser the way the Browser plugin does: open, look, click, read. */
export const plugin = {
  name: 'browserish',
  inject: ['tools', 'browser', 'commands'],
  apply(ctx) {
    ctx.tools.register({
      name: 'look',
      description: 'Opens a URL, clicks once, and reports what the page says.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      execute: async (args) => {
        const page = await ctx.browser.open(String(args.url))
        await ctx.browser.click(10, 20)
        const shot = await ctx.browser.screenshot()
        const value = await ctx.browser.evaluate('1 + 1')
        return JSON.stringify({ page, shot: shot.slice(0, 22), value })
      },
    })
    ctx.commands.register({
      name: 'peek',
      description: 'Opens a URL from a command.',
      run: async (argument) => {
        await ctx.browser.open(String(argument))
      },
    })
    ctx.tools.register({
      name: 'leave',
      description: 'Closes the browser.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        await ctx.browser.close()
        return 'closed'
      },
    })
  },
}
