import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmAction } from './dialog'

afterEach(() => {
  clearMocks()
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('confirmAction', () => {
  it('uses a native dialog inside the app and reads the clicked label', async () => {
    const calls: [string, unknown][] = []
    mockIPC((command, payload) => {
      calls.push([command, payload])
      return 'Clear history'
    })
    const confirm = vi.spyOn(window, 'confirm')

    await expect(confirmAction('Sure?', 'Clear history')).resolves.toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(calls[0][0]).toBe('plugin:dialog|message')
    expect(calls[0][1]).toMatchObject({
      message: 'Sure?',
      buttons: { OkCancelCustom: ['Clear history', 'Cancel'] },
    })
  })

  it('is false when the native dialog is cancelled', async () => {
    mockIPC(() => 'Cancel')
    await expect(confirmAction('Sure?', 'Clear history')).resolves.toBe(false)
  })

  it('falls back to window.confirm in a plain browser', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await expect(confirmAction('Sure?', 'Clear history')).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledWith('Sure?')
  })
})
