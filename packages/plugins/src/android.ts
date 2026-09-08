import type { HarnessContext, HarnessPlugin } from '@harnessdesk/cordis-host'

/**
 * Android devices and emulators, as tools every agent can call.
 *
 * The engine is `ctx.android` (adb in the plugin host). Screencap pixels
 * ARE Android's input coordinate space, so the see-then-act contract is
 * exact: tap what the screenshot showed. A machine without adb gets a
 * sentence naming the install.
 */

export const androidPlugin: HarnessPlugin = {
  manifest: {
    id: 'android',
    name: 'Android',
    description:
      'Install, launch, see, tap, and type on Android devices and emulators — so an agent can run and verify the app it just built.',
    permissions: { android: true },
  },
  plugin: {
    name: 'android',
    inject: ['tools', 'android'],
    apply(ctx: HarnessContext) {
      const look = async (note: string) => {
        const shot = await ctx.android.screenshot()
        return [
          { type: 'text' as const, text: note || 'Screen' },
          { type: 'image' as const, url: shot, mimeType: 'image/png' },
        ]
      }

      ctx.tools.register({
        name: 'android_devices',
        description: 'List connected Android devices and running emulators.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          const devices = await ctx.android.devices()
          if (devices.length === 0) return 'No Android device or emulator is connected.'
          return devices.map((d) => `${d.serial} · ${d.state} · ${d.description}`).join('\n')
        },
      })

      ctx.tools.register({
        name: 'android_install',
        description: 'Install an APK onto the connected device or emulator.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Path to the .apk.' } },
          required: ['path'],
        },
        execute: async (args: { path: string }) => {
          await ctx.android.install(String(args.path))
          return `Installed ${String(args.path)}.`
        },
      })

      ctx.tools.register({
        name: 'android_launch',
        description:
          'Launch an app: a package name (com.example.app) or a full component (com.example.app/.MainActivity). Returns a screenshot.',
        inputSchema: {
          type: 'object',
          properties: { target: { type: 'string' } },
          required: ['target'],
        },
        execute: async (args: { target: string }) => {
          await ctx.android.launch(String(args.target))
          await new Promise((resolve) => setTimeout(resolve, 1_500))
          return look(`Launched ${String(args.target)}`)
        },
      })

      ctx.tools.register({
        name: 'android_screenshot',
        description: 'Screenshot the device. Tap coordinates use these exact pixels.',
        inputSchema: { type: 'object', properties: {} },
        execute: () => look(''),
      })

      ctx.tools.register({
        name: 'android_tap',
        description:
          'Tap at coordinates in the pixels of the screenshots (origin top-left), then return a fresh screenshot.',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'Pixels from the left.' },
            y: { type: 'number', description: 'Pixels from the top.' },
          },
          required: ['x', 'y'],
        },
        execute: async (args: { x: number; y: number }) => {
          await ctx.android.tap(Number(args.x), Number(args.y))
          await new Promise((resolve) => setTimeout(resolve, 500))
          return look(`Tapped (${Number(args.x)}, ${Number(args.y)})`)
        },
      })

      ctx.tools.register({
        name: 'android_key',
        description: 'Press a key: ENTER, BACK, HOME, TAB, or any KEYCODE_* name. Returns a screenshot.',
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
        },
        execute: async (args: { key: string }) => {
          await ctx.android.key(String(args.key))
          await new Promise((resolve) => setTimeout(resolve, 400))
          return look(`Pressed ${String(args.key)}`)
        },
      })

      ctx.tools.register({
        name: 'android_text',
        description: 'Type text into the focused field, then return a screenshot.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        execute: async (args: { text: string }) => {
          await ctx.android.text(String(args.text))
          await new Promise((resolve) => setTimeout(resolve, 400))
          return look('Typed')
        },
      })

      ctx.tools.register({
        name: 'android_logcat',
        description: 'The last lines of logcat, optionally filtered to one tag.',
        inputSchema: {
          type: 'object',
          properties: {
            lines: { type: 'number', description: 'How many lines (default 100, max 1000).' },
            tag: { type: 'string', description: 'Only this tag.' },
          },
        },
        execute: async (args: { lines?: number; tag?: string }) =>
          ctx.android.logcat(Number(args.lines) || 100, args.tag ? String(args.tag) : undefined),
      })
    },
  },
}
