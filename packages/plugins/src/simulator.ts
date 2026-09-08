import type { HarnessContext, HarnessPlugin } from '@harnessdesk/cordis-host'

/**
 * The iOS Simulator, as tools every agent can call.
 *
 * The engine is `ctx.ios` (simctl in the plugin host); this plugin is only
 * the tool surface. Interaction tools return a fresh screenshot — after
 * acting, the next thing an agent does is look — and `ios_tap` takes the
 * pixels of the screenshot it was just shown, the same contract the browser
 * tools set.
 */

export const simulatorPlugin: HarnessPlugin = {
  manifest: {
    id: 'simulator',
    name: 'iOS Simulator',
    description:
      'Boot, install, launch, see, and tap the iOS Simulator — so an agent can run and verify the app it just built.',
    permissions: { ios: true },
  },
  plugin: {
    name: 'simulator',
    inject: ['tools', 'ios'],
    apply(ctx: HarnessContext) {
      const look = async (note: string) => {
        const shot = await ctx.ios.screenshot()
        const device = await ctx.ios.booted()
        return [
          { type: 'text' as const, text: `${note ? `${note} — ` : ''}${device.name} (${device.runtime})` },
          { type: 'image' as const, url: shot, mimeType: 'image/png' },
        ]
      }

      ctx.tools.register({
        name: 'ios_devices',
        description: 'List the available iOS simulators and their states.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          const devices = await ctx.ios.devices()
          return devices
            .map((d) => `${d.state === 'Booted' ? '●' : '○'} ${d.name} · ${d.runtime} · ${d.udid}`)
            .join('\n')
        },
      })

      ctx.tools.register({
        name: 'ios_boot',
        description: 'Boot a simulator by udid — the list of devices reports them — and open the Simulator window.',
        inputSchema: {
          type: 'object',
          properties: { udid: { type: 'string', description: 'The device udid.' } },
          required: ['udid'],
        },
        execute: async (args: { udid: string }) => {
          await ctx.ios.boot(String(args.udid))
          return look('Booted')
        },
      })

      ctx.tools.register({
        name: 'ios_install',
        description: 'Install a built .app bundle onto the booted simulator.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Path to the .app bundle.' } },
          required: ['path'],
        },
        execute: async (args: { path: string }) => {
          await ctx.ios.install(String(args.path))
          return `Installed ${String(args.path)}.`
        },
      })

      ctx.tools.register({
        name: 'ios_launch',
        description: 'Launch an app by bundle id on the booted simulator, then screenshot it.',
        inputSchema: {
          type: 'object',
          properties: { bundleId: { type: 'string', description: 'e.g. com.example.MyApp' } },
          required: ['bundleId'],
        },
        execute: async (args: { bundleId: string }) => {
          await ctx.ios.launch(String(args.bundleId))
          await new Promise((resolve) => setTimeout(resolve, 1_200))
          return look(`Launched ${String(args.bundleId)}`)
        },
      })

      ctx.tools.register({
        name: 'ios_screenshot',
        description: 'Screenshot the booted simulator. Tap coordinates use these exact pixels.',
        inputSchema: { type: 'object', properties: {} },
        execute: () => look(''),
      })

      ctx.tools.register({
        name: 'ios_tap',
        description:
          'Tap the booted simulator at coordinates in the pixels of the screenshots (origin top-left), then return a fresh screenshot.',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'Pixels from the left of the screenshot.' },
            y: { type: 'number', description: 'Pixels from the top of the screenshot.' },
          },
          required: ['x', 'y'],
        },
        execute: async (args: { x: number; y: number }) => {
          await ctx.ios.tap(Number(args.x), Number(args.y))
          await new Promise((resolve) => setTimeout(resolve, 600))
          return look(`Tapped (${Number(args.x)}, ${Number(args.y)})`)
        },
      })

      ctx.tools.register({
        name: 'ios_open_url',
        description: 'Open a URL (https:// or a deep link) on the booted simulator.',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
        },
        execute: async (args: { url: string }) => {
          await ctx.ios.openUrl(String(args.url))
          await new Promise((resolve) => setTimeout(resolve, 1_200))
          return look(`Opened ${String(args.url)}`)
        },
      })

      ctx.tools.register({
        name: 'ios_terminate',
        description: 'Terminate an app by bundle id on the booted simulator.',
        inputSchema: {
          type: 'object',
          properties: { bundleId: { type: 'string' } },
          required: ['bundleId'],
        },
        execute: async (args: { bundleId: string }) => {
          await ctx.ios.terminate(String(args.bundleId))
          return `Terminated ${String(args.bundleId)}.`
        },
      })
    },
  },
}
