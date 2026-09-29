import { describe, expect, it } from 'vitest'
import { AUTO_UPDATE_KEY, readAutoUpdate, saveAutoUpdate } from './updates'

describe('the update preference', () => {
  it('is on until turned off', () => {
    expect(readAutoUpdate()).toBe(true)
  })

  it('remembers being turned off, and on again', () => {
    saveAutoUpdate(false)
    expect(localStorage.getItem(AUTO_UPDATE_KEY)).toBe('off')
    expect(readAutoUpdate()).toBe(false)

    saveAutoUpdate(true)
    expect(readAutoUpdate()).toBe(true)
  })
})
