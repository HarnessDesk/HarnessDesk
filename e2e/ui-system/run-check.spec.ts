import { expect, test, type Page } from '@playwright/test'

/**
 * The question, mounted on the page's own store.
 *
 * The appended source is part of `main.tsx` itself, so `Mount`, `RunCheck` and
 * `PREVIEW_UNSEEN` are the bindings the page already holds. Importing them again
 * by bare URL would load a second copy of `harness.tsx` beside the one the page
 * runs once Vite has hot-reloaded it, and with it a second store (#1313).
 */
const mountQuestion = async (page: Page): Promise<void> => {
  await page.route('**/src/preview/main.tsx*', async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({
      response,
      body: `${source}
        import questionReact from ${JSON.stringify(reactUrl)};
        window.__answers = 0;
        const QuestionFrame = () => {
          const [open, setOpen] = questionReact.useState(false);
          return questionReact.createElement(Mount, null,
            questionReact.createElement('button', {
              type: 'button',
              onClick: () => setTimeout(() => setOpen(true), 300),
            }, 'Ask the question'),
            open && questionReact.createElement(RunCheck, {
              unseen: PREVIEW_UNSEEN,
              card: 2,
              busy: false,
              onRun: () => { window.__answers += 1; setOpen(false); },
              onCancel: () => setOpen(false),
            }),
          );
        };
        const questionFrame = document.createElement('section');
        questionFrame.setAttribute('aria-label', 'Run check fixture');
        document.body.append(questionFrame);
        createRoot(questionFrame).render(questionReact.createElement(QuestionFrame));
      `,
    })
  })
  await page.goto('/preview.html')
}

const answers = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __answers: number }).__answers)

const question = (page: Page) =>
  page.getByRole('alertdialog', { name: /lint has changed since it last ran here/ })

test('a Return held from the press through the question opening answers nothing', async ({ page }) => {
  await mountQuestion(page)
  const ask = page.getByRole('button', { name: 'Ask the question' })
  await ask.focus()
  await page.keyboard.down('Enter')
  for (let n = 0; n < 24; n += 1) {
    await page.keyboard.down('Enter')
    await page.waitForTimeout(40)
  }
  await page.keyboard.up('Enter')
  await expect(question(page)).toBeVisible()
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('Ask the question')
  expect(await answers(page)).toBe(0)
})

test('a press on the backdrop neither answers nor dismisses the question', async ({ page }) => {
  await mountQuestion(page)
  await page.getByRole('button', { name: 'Ask the question' }).click()
  await expect(question(page)).toBeVisible()
  await page.mouse.click(8, 8)
  await expect(question(page)).toBeVisible()
  expect(await answers(page)).toBe(0)
})

test('a click already on its way when the question opens answers nothing; once armed, a click answers once', async ({ page }) => {
  await mountQuestion(page)
  await page.getByRole('button', { name: 'Ask the question' }).click()
  await expect(question(page)).toBeVisible()
  const run = question(page).getByRole('button', { name: 'Run lint' })
  const box = await run.boundingBox()
  if (!box) throw new Error('the answer is not drawn')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  expect(await answers(page)).toBe(0)
  await expect(question(page)).toBeVisible()

  await expect(run).toBeEnabled()
  await run.click()
  await expect(question(page)).toBeHidden()
  expect(await answers(page)).toBe(1)
})
