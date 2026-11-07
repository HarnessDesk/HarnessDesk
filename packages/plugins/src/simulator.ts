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
      const udidSchema = { type: 'string', minLength: 1, pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', description: 'The device udid. Required when more than one simulator is booted.' }
      const bundleId = (value: string): string => {
        if (value.startsWith('-')) throw new Error('An app bundle id cannot begin with -.')
        return value
      }
      const target = async (udid?: string) => (await ctx.ios.booted(udid)).udid
      const look = async (note: string, udid?: string) => {
        const frame = await ctx.ios.frame(udid)
        return [
          { type: 'text' as const, text: `${note ? `${note} — ` : ''}${frame.udid} · ${frame.width} × ${frame.height} pixels · ${frame.frameId}` },
          { type: 'image' as const, url: frame.url, mimeType: frame.mimeType },
        ]
      }

      ctx.tools.register({
        name: 'ios_diagnose',
        title: 'Check iOS Simulator setup',
        description: 'Check Xcode selection, license, iOS support and simulator runtimes without changing setup.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => JSON.stringify(await ctx.ios.diagnose()),
      })

      ctx.tools.register({
        name: 'ios_get_appearance',
        title: 'Read simulator appearance',
        description: 'Read the simulator appearance: light, dark, unsupported or unknown.',
        inputSchema: { type: 'object', properties: { udid: udidSchema }, additionalProperties: false },
        execute: async (args: { udid?: string }) => ctx.ios.getAppearance(await target(args.udid)),
      })

      ctx.tools.register({
        name: 'ios_set_appearance',
        title: 'Set simulator appearance',
        description: 'Set light or dark appearance and report the requested state, observed state and whether it applied.',
        inputSchema: {
          type: 'object',
          properties: { udid: udidSchema, appearance: { type: 'string', enum: ['light', 'dark'] } },
          required: ['appearance'], additionalProperties: false,
        },
        execute: async (args: { udid?: string; appearance: 'light' | 'dark' }) => {
          if (args.appearance !== 'light' && args.appearance !== 'dark') throw new Error('Appearance must be light or dark.')
          const observed = await ctx.ios.setAppearance(args.appearance, await target(args.udid))
          return { requested: args.appearance, observed, applied: observed === args.appearance }
        },
      })

      ctx.tools.register({
        name: 'ios_devices',
        title: 'List iOS simulators',
        description: 'List the available iOS simulators and their states.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          const devices = await ctx.ios.devices()
          return devices
            .map((d) => `${d.state === 'Booted' ? '●' : '○'} ${d.name} · ${d.runtime} · ${d.udid}`)
            .join('\n')
        },
      })

      ctx.tools.register({
        name: 'ios_boot',
        title: 'Boot an iOS simulator',
        description: 'Boot a simulator by udid. Opens the Simulator window unless openWindow is false.',
        inputSchema: {
          type: 'object',
          properties: { udid: udidSchema, openWindow: { type: 'boolean', description: 'Open the Simulator window (default true).' } },
          required: ['udid'], additionalProperties: false,
        },
        execute: async (args: { udid: string; openWindow?: boolean }) => {
          await ctx.ios.boot(String(args.udid), { openWindow: args.openWindow })
          return look('Booted', args.udid)
        },
      })

      ctx.tools.register({
        name: 'ios_install',
        title: 'Install an iOS app',
        description: 'Install a built .app bundle onto the booted simulator.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Path to the .app bundle.' }, udid: udidSchema },
          required: ['path'], additionalProperties: false,
        },
        execute: async (args: { path: string; udid?: string }) => {
          await ctx.ios.install(String(args.path), await target(args.udid))
          return `Installed ${String(args.path)}.`
        },
      })

      ctx.tools.register({
        name: 'ios_launch',
        title: 'Launch an iOS app',
        description: 'Launch an app by bundle id on the booted simulator, then screenshot it.',
        inputSchema: {
          type: 'object',
          properties: { bundleId: { type: 'string', description: 'e.g. com.example.MyApp' }, udid: udidSchema },
          required: ['bundleId'], additionalProperties: false,
        },
        execute: async (args: { bundleId: string; udid?: string }) => {
          const bundle = bundleId(String(args.bundleId))
          const udid = await target(args.udid)
          await ctx.ios.launch(bundle, udid)
          await new Promise((resolve) => setTimeout(resolve, 1_200))
          return look(`Launched ${String(args.bundleId)}`, udid)
        },
      })

      ctx.tools.register({
        name: 'ios_screenshot',
        title: 'Screenshot the iOS simulator',
        description: 'Screenshot the booted simulator. Tap coordinates use these exact pixels.',
        inputSchema: { type: 'object', properties: { udid: udidSchema }, additionalProperties: false },
        execute: (args: { udid?: string }) => look('', args.udid),
      })

      ctx.tools.register({
        name: 'ios_tap',
        title: 'Tap the iOS simulator',
        description:
          'With exactly one simulator booted, tap at coordinates in the pixels of the screenshots (origin top-left), then return a fresh screenshot.',
        inputSchema: {
          type: 'object',
          properties: {
            udid: udidSchema,
            x: { type: 'number', description: 'Pixels from the left of the screenshot.' },
            y: { type: 'number', description: 'Pixels from the top of the screenshot.' },
          },
          required: ['x', 'y'], additionalProperties: false,
        },
        execute: async (args: { x: number; y: number; udid?: string }) => {
          const udid = await target(args.udid)
          await ctx.ios.tap(Number(args.x), Number(args.y), udid)
          await new Promise((resolve) => setTimeout(resolve, 600))
          return look(`Tapped (${Number(args.x)}, ${Number(args.y)})`, udid)
        },
      })

      ctx.tools.register({
        name: 'ios_open_url',
        title: 'Open a URL in the iOS simulator',
        description: 'Open a URL (https:// or a deep link) on the booted simulator.',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' }, udid: udidSchema },
          required: ['url'], additionalProperties: false,
        },
        execute: async (args: { url: string; udid?: string }) => {
          const udid = await target(args.udid)
          await ctx.ios.openUrl(String(args.url), udid)
          await new Promise((resolve) => setTimeout(resolve, 1_200))
          return look(`Opened ${String(args.url)}`, udid)
        },
      })

      ctx.tools.register({
        name: 'ios_terminate',
        title: 'Stop an iOS app',
        description: 'Terminate an app by bundle id on the booted simulator.',
        inputSchema: {
          type: 'object',
          properties: { bundleId: { type: 'string' }, udid: udidSchema },
          required: ['bundleId'], additionalProperties: false,
        },
        execute: async (args: { bundleId: string; udid?: string }) => {
          await ctx.ios.terminate(bundleId(String(args.bundleId)), await target(args.udid))
          return `Terminated ${String(args.bundleId)}.`
        },
      })
    },
  },
}
