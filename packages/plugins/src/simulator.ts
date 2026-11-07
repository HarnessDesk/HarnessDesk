import type { IosAction, IosFrame, HarnessContext, HarnessPlugin } from '@harnessdesk/cordis-host'

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
      const renderFrame = (frame: IosFrame, note = '') => [
          { type: 'text' as const, text: `${note ? `${note} — ` : ''}${frame.inputMethod ? `${frame.inputMethod} · ` : ''}${frame.udid} · ${frame.width} × ${frame.height} pixels · ${frame.frameId}` },
          { type: 'image' as const, url: frame.url, mimeType: frame.mimeType },
        ]
      const look = async (note: string, udid?: string) => renderFrame(await ctx.ios.frame(udid), note)

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

      const ref = (name: string) => ({ $ref: `#/$defs/${name}` })
      const coordinate = { type: 'number', minimum: 0 }
      const duration = (value: number) => ({ type: 'integer', minimum: 1, maximum: 10000, default: value })
      const defs = {
        udid: udidSchema, frameId: { type: 'string', minLength: 1 }, coordinate,
        duration: { type: 'integer', minimum: 1, maximum: 10000 },
        point: { type: 'object', properties: { x: ref('coordinate'), y: ref('coordinate') }, required: ['x','y'], additionalProperties: false },
        sample: { type: 'object', properties: { x: ref('coordinate'), y: ref('coordinate'), tMs: { type: 'integer', minimum: 0, maximum: 10000 } }, required: ['x','y','tMs'], additionalProperties: false },
      }
      const pixelTarget = { udid: ref('udid'), frameId: ref('frameId') }
      const deviceTarget = { udid: ref('udid') }
      const inputs = [
        { name: 'ios_tap', kind: 'tap', title: 'Tap the iOS simulator', properties: { ...pixelTarget, x: coordinate, y: coordinate }, required: ['x','y'] },
        { name: 'ios_long_press', kind: 'longPress', title: 'Long press the iOS simulator', properties: { ...pixelTarget, x: ref('coordinate'), y: ref('coordinate'), durationMs: duration(750) }, required: ['x','y'], defaults: { durationMs: 750 } },
        { name: 'ios_swipe', kind: 'swipe', title: 'Swipe the iOS simulator', properties: { ...pixelTarget, from: ref('point'), to: ref('point'), durationMs: duration(350) }, required: ['from','to'], defaults: { durationMs: 350 } },
        { name: 'ios_drag', kind: 'drag', title: 'Drag on the iOS simulator', properties: { ...pixelTarget, path: { type: 'array', minItems: 2, maxItems: 600, items: ref('sample') } }, required: ['path'] },
        { name: 'ios_pinch', kind: 'pinch', title: 'Pinch the iOS simulator', properties: { ...pixelTarget, center: ref('point'), startDistance: { type: 'number', exclusiveMinimum: 0 }, endDistance: { type: 'number', exclusiveMinimum: 0 }, durationMs: duration(500) }, required: ['center','startDistance','endDistance'], defaults: { durationMs: 500 } },
        { name: 'ios_rotate_gesture', kind: 'rotateGesture', title: 'Rotate a gesture on the iOS simulator', properties: { ...pixelTarget, center: ref('point'), radius: { type: 'number', exclusiveMinimum: 0 }, angleDegrees: { type: 'number', minimum: -360, maximum: 360 }, durationMs: duration(500) }, required: ['center','radius','angleDegrees'], defaults: { durationMs: 500 } },
        { name: 'ios_text', kind: 'text', title: 'Enter text in the iOS simulator', properties: { ...deviceTarget, text: { type: 'string', minLength: 1, maxLength: 16384 } }, required: ['text'] },
        { name: 'ios_key', kind: 'key', title: 'Press an iOS simulator key', properties: { ...deviceTarget, key: { type: 'string', enum: ['return','delete','left','right','up','down','selectAll','undo'] }, count: { type: 'integer', minimum: 1, maximum: 100, default: 1 } }, required: ['key'], defaults: { count: 1 } },
        { name: 'ios_button', kind: 'button', title: 'Press an iOS simulator button', properties: { ...deviceTarget, button: { type: 'string', enum: ['home','lock','side'] }, durationMs: duration(100) }, required: ['button'], defaults: { durationMs: 100 } },
        { name: 'ios_rotate', kind: 'rotateDevice', title: 'Rotate the iOS simulator device', properties: { ...deviceTarget, orientation: { type: 'string', enum: ['portrait','portraitUpsideDown','landscapeLeft','landscapeRight'] } }, required: ['orientation'] },
        { name: 'ios_keyboard', kind: 'keyboard', title: 'Set the iOS software keyboard', properties: { ...deviceTarget, visible: { type: 'boolean' } }, required: ['visible'] },
      ]
      for (const input of inputs) ctx.tools.register({
        name: input.name, title: input.title,
        description: `${input.title}.${'frameId' in input.properties ? ' Coordinates and distances are original screenshot pixels.' : ''} Returns a fresh frame of the concrete target; unverified native operations are refused.`,
        inputSchema: { type: 'object', $defs: defs, properties: input.properties, required: input.required, additionalProperties: false },
        execute: async (args: Record<string, unknown>) => {
          const { udid, ...values } = args
          const action = { ...input.defaults, ...values, kind: input.kind } as IosAction
          return renderFrame(await ctx.ios.interact(action, udid as string | undefined))
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
