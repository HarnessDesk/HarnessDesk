import { expect, test, type Page } from '@playwright/test'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAYAAABOzvzpAAAAbElEQVR4nO3QMREAIBDAsBeFGPwrwAHIyECH7L3O2uf+bHSA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AHaA5Jyz2mkK96sAAAAAElFTkSuQmCC'

const mount = async (page: Page, kind: 'missing' | 'binary' | 'image') => {
  await page.unrouteAll({ behavior: 'wait' })
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"]*\/react\.js[^"]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('Preview React module import was not found')
    await route.fulfill({ response, body: `${source}
      import fileReact from ${JSON.stringify(reactUrl)};
      import { FilePane as BinaryFilePane } from '/src/components/FilePane.tsx';
      import { MountProvider as BinaryMountProvider } from '/src/panels/mount.tsx';
      const fileKind = ${JSON.stringify(kind)};
      const fileTransport = { request: async (method, params = {}) => {
        if (method === 'workspace/stat') return { kind: 'file', isSymlink: false, modifiedAt: 1 };
        if (method === 'workspace/readFile') {
          if (fileKind === 'missing') return { kind: 'missing' };
          if (fileKind === 'image') return params.encoding === 'base64'
            ? { kind: 'binary', content: ${JSON.stringify(PNG)}, size: 120, hash: 'fixture' }
            : { kind: 'binary', size: 120, hash: 'fixture' };
          return { kind: 'binary', size: 1536, hash: 'fixture' };
        }
        return null;
      }};
      const fileStore = new Proxy(store, { get: (target, key) => key === 'transport' ? fileTransport : Reflect.get(target, key) });
      const fileFrame = document.createElement('section');
      fileFrame.setAttribute('aria-label', 'File binary fixture');
      Object.assign(fileFrame.style, { position: 'fixed', top: '160px', left: '24px', width: '640px', height: '480px', zIndex: '10' });
      document.body.append(fileFrame);
      createRoot(fileFrame).render(fileReact.createElement(StoreProvider, { store: fileStore },
        fileReact.createElement(BinaryMountProvider, { scope: { area: 'main', id: 'file-binary-fixture', view: { kind: 'file', path: fileKind === 'image' ? '/work/project/tiny.png' : fileKind === 'missing' ? '/work/project/missing.ts' : '/work/project/data.bin', runtime: 'claude' } } },
          fileReact.createElement(BinaryFilePane))));
    ` })
  })
  await page.goto('/preview.html')
  return page.getByRole('region', { name: 'File binary fixture' })
}

test('FilePane distinguishes missing files, binary data, and image previews in both themes', async ({ page }, testInfo) => {
  await mount(page, 'missing')
  const missing = page.getByRole('region', { name: 'File binary fixture' })
  await expect(missing.getByRole('button', { name: 'Create this file' })).toBeVisible()

  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    const binary = await mount(page, 'binary')
    await expect(binary.getByText('Binary file — 1.5 KB')).toBeVisible()
    await expect(binary.getByRole('button', { name: 'Create this file' })).toHaveCount(0)
    await binary.screenshot({ path: testInfo.outputPath(`after-binary-${theme}.png`) })

    const image = await mount(page, 'image')
    await expect(image.locator('img')).toHaveAttribute('src', `data:image/png;base64,${PNG}`)
    await expect.poll(() => image.locator('img').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(64)
    await expect(image.getByRole('button', { name: 'Create this file' })).toHaveCount(0)
    await image.screenshot({ path: testInfo.outputPath(`after-image-${theme}.png`) })
  }
})
