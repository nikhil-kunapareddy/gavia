import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inApp } from './api'
import { downloadUpdate } from './updateService'

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }))
vi.mock('./api', () => ({ inApp: vi.fn() }))

const checkMock = vi.mocked(check)
const relaunchMock = vi.mocked(relaunch)
const inAppMock = vi.mocked(inApp)

function fakeUpdate(overrides: Partial<Record<'download' | 'install', () => Promise<void>>> = {}) {
  return {
    version: '0.3.0',
    download: vi.fn(() => Promise.resolve()),
    install: vi.fn(() => Promise.resolve()),
    ...overrides,
  }
}

beforeEach(() => {
  checkMock.mockReset()
  relaunchMock.mockReset()
  inAppMock.mockReturnValue(true)
})

describe('downloadUpdate', () => {
  it('does nothing outside the app', async () => {
    inAppMock.mockReturnValue(false)

    expect(await downloadUpdate()).toBeNull()
    expect(checkMock).not.toHaveBeenCalled()
  })

  it('resolves to null when there is nothing newer', async () => {
    checkMock.mockResolvedValue(null)
    expect(await downloadUpdate()).toBeNull()
  })

  it('downloads a newer release before offering it', async () => {
    const update = fakeUpdate()
    checkMock.mockResolvedValue(update as unknown as Update)

    const ready = await downloadUpdate()

    expect(ready?.version).toBe('0.3.0')
    expect(update.download).toHaveBeenCalledTimes(1)
    expect(update.install).not.toHaveBeenCalled()
  })

  it('installs, then restarts into the new version', async () => {
    const order: string[] = []
    const update = fakeUpdate({
      install: vi.fn(() => {
        order.push('install')
        return Promise.resolve()
      }),
    })
    checkMock.mockResolvedValue(update as unknown as Update)
    relaunchMock.mockImplementation(() => {
      order.push('relaunch')
      return Promise.resolve()
    })

    await (await downloadUpdate())?.install()

    expect(order).toEqual(['install', 'relaunch'])
  })

  it('passes an install failure on, without restarting', async () => {
    const update = fakeUpdate({ install: () => Promise.reject(new Error('not an AppImage')) })
    checkMock.mockResolvedValue(update as unknown as Update)

    const ready = await downloadUpdate()

    await expect(ready?.install()).rejects.toThrow('not an AppImage')
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['the check', () => checkMock.mockRejectedValue(new Error('offline'))],
    [
      'the download',
      () =>
        checkMock.mockResolvedValue(
          fakeUpdate({ download: () => Promise.reject(new Error('reset')) }) as unknown as Update,
        ),
    ],
  ])('treats a failure in %s as no update', async (_, arrange) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    arrange()

    expect(await downloadUpdate()).toBeNull()
    expect(warn).toHaveBeenCalled()
  })
})
