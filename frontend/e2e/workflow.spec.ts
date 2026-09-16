/**
 * The app as a person actually uses it: real browser, real Vite build, real
 * FastAPI process, real ONNX model, real SQLite file.
 *
 * If these pass, the thing works.
 */

import type { ApiModel } from './fixtures'
import { App, BLANK_PNG, expect, hasRealPhotos, loonPhotos, test } from './fixtures'

test.describe('the service is up', () => {
  test('reports a loaded model', async ({ page }) => {
    const app = new App(page)

    const health = await app.getJson<{ status: string }>('/api/health')
    expect(health.status).toBe('ok')

    const model = await app.getJson<ApiModel>('/api/model')
    expect(model.classes).toEqual(['common loon'])
    expect(model.provider).toBe('CPUExecutionProvider')
  })
})

test.describe('checking a photograph', () => {
  test.skip(!hasRealPhotos, 'needs the loonnet_v1 dataset')

  test('finds loons and draws a box for each', async ({ app }) => {
    await app.chooseFile(loonPhotos(1)[0])
    await app.check()

    await expect(app.resultHeading()).toBeVisible({ timeout: 30_000 })
    await expect(app.resultHeading()).toContainText(/loon/i)

    const boxes = app.detectionBoxes()
    await expect(boxes.first()).toBeVisible()

    // Every box must sit inside the frame, or it is drawn off the photo.
    const frame = await app.page.locator('.annotation-frame').boundingBox()
    const count = await boxes.count()
    for (let index = 0; index < count; index += 1) {
      const box = await boxes.nth(index).boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(frame!.x - 2)
      expect(box!.y).toBeGreaterThanOrEqual(frame!.y - 2)
      expect(box!.x + box!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 2)
      expect(box!.y + box!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 2)
    }
  })

  test('shows a confidence for each detection', async ({ app }) => {
    await app.chooseFile(loonPhotos(1)[0])
    await app.check()
    await expect(app.resultHeading()).toBeVisible({ timeout: 30_000 })

    await expect(app.detectionBoxes().first()).toContainText(/^1 · \d{1,3}%$/)
  })

  test('shows the preview image before anything is saved', async ({ app }) => {
    await app.chooseFile(loonPhotos(1)[0])
    await app.check()
    await expect(app.resultHeading()).toBeVisible({ timeout: 30_000 })

    // Nothing is on the server yet, so this is the browser's own object URL.
    await expect(app.annotatedImage()).toHaveAttribute('src', /^blob:/)
  })
})

test.describe('a photograph with no loons', () => {
  test('is reported as a clear result, not an error', async ({ app }) => {
    await app.chooseFile({ name: 'blank.png', mimeType: 'image/png', buffer: BLANK_PNG })
    await app.check()

    await expect(app.resultHeading()).toBeVisible({ timeout: 30_000 })
    await expect(app.resultHeading()).toContainText(/No loon/i)
    await expect(app.detectionBoxes()).toHaveCount(0)
    await expect(app.page.getByRole('alert')).toHaveCount(0)
  })
})

test.describe('keeping a result', () => {
  test('the full journey: check, keep, revisit, delete', async ({ app, page }) => {
    const photo = hasRealPhotos
      ? loonPhotos(1)[0]
      : { name: 'blank.png', mimeType: 'image/png' as const, buffer: BLANK_PNG }

    // Check.
    await app.chooseFile(photo)
    await app.check()
    await expect(app.resultHeading()).toBeVisible({ timeout: 30_000 })

    // Nothing kept yet.
    expect(await app.history()).toHaveLength(0)

    // Keep it.
    await app.save()
    expect(await app.history()).toHaveLength(1)

    // It is in the history page, showing a server-rendered thumbnail.
    await app.openHistory()
    await expect(app.historyCards()).toHaveCount(1)
    await expect(app.historyCards().first().locator('img')).toHaveAttribute(
      'src',
      /\/api\/results\/.+\/thumb$/,
    )

    // Reopen it: now served from the API, and already saved.
    await app.historyCards().first().click()
    await expect(app.resultHeading()).toBeVisible()
    await expect(app.annotatedImage()).toHaveAttribute('src', /\/api\/results\/.+\/image$/)
    await expect(page.getByRole('button', { name: /Saved to history/ })).toBeDisabled()

    // Clear it.
    page.once('dialog', (dialog) => void dialog.accept())
    await app.openHistory()
    await page.getByRole('button', { name: /Clear history/ }).click()
    await expect(app.page.getByText(/No saved checks yet/)).toBeVisible()
  })

  test('the saved image is the original, byte for byte', async ({ app, page }) => {
    await app.chooseFile({ name: 'blank.png', mimeType: 'image/png', buffer: BLANK_PNG })
    await app.check()
    await expect(app.resultHeading()).toBeVisible({ timeout: 30_000 })
    await app.save()

    const [row] = await app.history()
    const served = await page.request.get(row.imageUrl)

    // A research record has to be the file the user uploaded, not a re-encode.
    expect(Buffer.from(await served.body()).equals(BLANK_PNG)).toBe(true)
  })

  test('survives a page reload', async ({ app, page }) => {
    await app.chooseFile({ name: 'blank.png', mimeType: 'image/png', buffer: BLANK_PNG })
    await app.check()
    await expect(app.resultHeading()).toBeVisible({ timeout: 30_000 })
    await app.save()

    // The point of moving off localStorage: the record is not in the browser.
    await page.reload()
    await app.openHistory()
    await expect(app.historyCards()).toHaveCount(1)
  })

  test('keeps several checks, newest first', async ({ app, page }) => {
    for (const name of ['first.png', 'second.png']) {
      await app.chooseFile({ name, mimeType: 'image/png', buffer: BLANK_PNG })
      await app.check()
      await expect(app.resultHeading()).toBeVisible({ timeout: 30_000 })
      await app.save()
      await page.getByRole('button', { name: /Check another/ }).click()
    }

    const history = await app.history()
    expect(history.map((row) => row.fileName)).toEqual(['second.png', 'first.png'])
  })
})

test.describe('rejected uploads', () => {
  test('an unsupported format is refused before anything is sent', async ({ app }) => {
    await app.chooseFile({
      name: 'notes.gif',
      mimeType: 'image/gif',
      buffer: Buffer.from('GIF89a'),
    })

    await expect(app.page.getByRole('alert')).toContainText(/isn't supported/i)
    await expect(app.page.getByRole('button', { name: /Check for loons/ })).toHaveCount(0)
  })

  test('a corrupt image gets a message and the user can try again', async ({ app }) => {
    await app.chooseFile({
      name: 'broken.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0xff, 0xd8, 0x00, 0x01, 0x02]),
    })
    await app.check()

    await expect(app.page.getByRole('alert')).toBeVisible({ timeout: 30_000 })
    // Crucially, the button comes back — a failed check must not strand you.
    await expect(app.page.getByRole('button', { name: /Check for loons/ })).toBeEnabled()
  })
})

test.describe('navigation', () => {
  test('moves between the three pages', async ({ app, page }) => {
    await app.openHistory()
    await expect(page.getByRole('heading', { name: 'Previous checks' })).toBeVisible()

    await page.getByRole('navigation').getByRole('button', { name: /About/ }).click()
    await expect(page.getByRole('heading', { name: /Built to support/ })).toBeVisible()

    await app.openCheckPage()
    await expect(page.getByRole('heading', { name: /Is this a loon\?/ })).toBeVisible()
  })

  test('works on a phone-sized screen', async ({ app: _app, page }) => {
    await page.setViewportSize({ width: 390, height: 844 })

    await page.getByRole('button', { name: 'Toggle navigation' }).click()
    await page.getByRole('navigation').getByRole('button', { name: /Previous checks/ }).click()

    await expect(page.getByRole('heading', { name: 'Previous checks' })).toBeVisible()
  })
})

test.describe('resilience', () => {
  test('says so when the backend cannot be reached', async ({ app, page }) => {
    await app.chooseFile({ name: 'blank.png', mimeType: 'image/png', buffer: BLANK_PNG })
    await page.route('**/api/detect', (route) => route.abort('failed'))

    await app.check()

    await expect(page.getByRole('alert')).toContainText(/Could not reach/i)
  })

  test('the app still loads when the history request fails', async ({ page }) => {
    await page.route('**/api/results', (route) => route.abort('failed'))
    await page.goto('/')

    // The check page is the app's core job and must not depend on history.
    await expect(page.getByRole('heading', { name: /Is this a loon\?/ })).toBeVisible()
  })
})
