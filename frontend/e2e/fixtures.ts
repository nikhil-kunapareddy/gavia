import { test as base, expect, type Page } from '@playwright/test'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * A real labelled loon photograph when the training data is on this machine,
 * otherwise a synthetic one.
 *
 * The synthetic fallback keeps the suite runnable anywhere; the assertions
 * that need an actual loon skip themselves via `hasRealPhotos`.
 */
const DATASET = join(homedir(), 'Documents/loonet/data/annotated/loonnet_v1/images')

export const hasRealPhotos = existsSync(DATASET)

export function loonPhotos(count = 2): string[] {
  if (!hasRealPhotos) return []
  return readdirSync(DATASET)
    .filter((name) => name.endsWith('.jpg'))
    .slice(0, count)
    .map((name) => join(DATASET, name))
}

/** A 1x1 PNG — valid, decodable, and certainly not a loon. */
export const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

/** The API shapes these tests read. Mirrors backend/app/schemas/detection.py. */
export interface ApiDetection {
  id: string
  label: string
  confidence: number
  boundingBox: { x: number; y: number; width: number; height: number }
}

export interface ApiResult {
  id: string
  imageUrl: string
  fileName: string
  fileSize: number
  detections: ApiDetection[]
  processingTime: number
  timestamp: string
  imageWidth: number
  imageHeight: number
  modelName: string
  tilesProcessed: number
  saved: boolean
}

export interface ApiModel {
  name: string
  classes: string[]
  provider: string
  inputSize: number
  tilingEnabled: boolean
}

export const test = base.extend<{ app: App }>({
  app: async ({ page }, use) => {
    const app = new App(page)
    await app.goto()
    await app.clearHistoryViaApi()
    await use(app)
  },
})

export { expect }

/**
 * Page object for the app. Keeps the specs readable and means a UI change
 * lands in one place rather than across every test.
 */
export class App {
  constructor(readonly page: Page) {}

  async goto() {
    await this.page.goto('/')
    await expect(
      this.page.getByRole('heading', { name: /Is this a loon\?/ }),
    ).toBeVisible()
  }

  /** Reset server state directly — faster and less brittle than via the UI. */
  async clearHistoryViaApi() {
    await this.page.request.delete('/api/results')
  }

  /** Typed GET, because Playwright's `json()` is `any`. */
  async getJson<T>(url: string): Promise<T> {
    const response = await this.page.request.get(url)
    expect(response.ok()).toBe(true)
    return (await response.json()) as T
  }

  async history(): Promise<ApiResult[]> {
    return this.getJson<ApiResult[]>('/api/results')
  }

  async chooseFile(path: string | { name: string; mimeType: string; buffer: Buffer }) {
    await this.page.locator('input[type="file"]').first().setInputFiles(path)
  }

  async check() {
    await this.page.getByRole('button', { name: /Check for loons/ }).click()
  }

  async save() {
    await this.page.getByRole('button', { name: /^Save result/ }).click()
    await expect(this.page.getByRole('button', { name: /Saved to history/ })).toBeVisible()
  }

  async openHistory() {
    await this.page.getByRole('navigation').getByRole('button', { name: /Previous checks/ }).click()
    await expect(this.page.getByRole('heading', { name: 'Previous checks' })).toBeVisible()
  }

  async openCheckPage() {
    await this.page.getByRole('navigation').getByRole('button', { name: 'Check an image' }).click()
  }

  resultHeading() {
    return this.page.locator('.result-banner h1')
  }

  detectionBoxes() {
    return this.page.locator('.detection-box')
  }

  historyCards() {
    return this.page.locator('.history-card')
  }

  annotatedImage() {
    return this.page.locator('.annotation-frame img')
  }
}
