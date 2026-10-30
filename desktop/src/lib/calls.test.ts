import { describe, expect, it } from 'vitest'
import {
  MAX_RECORDING_MB,
  callEpisodes,
  formatClock,
  pluralizeCalls,
  recordingProblem,
  windowsCsv,
} from './calls'

function file(name: string, type: string, size = 10) {
  const recording = new File(['x'], name, { type })
  Object.defineProperty(recording, 'size', { value: size })
  return recording
}

function windows(...confidences: number[]) {
  return confidences.map((confidence, index) => ({
    start: index * 3,
    end: index * 3 + 3,
    confidence,
  }))
}

describe('recordingProblem', () => {
  it.each([
    ['lake.mp3', 'audio/mpeg'],
    ['lake.wav', 'audio/wav'],
    ['memo.m4a', 'audio/x-m4a'],
    ['drone.mp4', 'video/mp4'],
    // Some systems give no type at all; the extension decides then.
    ['field.flac', ''],
    ['night.OGG', ''],
  ])('accepts %s', (name, type) => {
    expect(recordingProblem(file(name, type))).toBeNull()
  })

  it.each([
    ['loon.jpg', 'image/jpeg'],
    ['notes.txt', 'text/plain'],
    ['batch.zip', 'application/zip'],
  ])('turns away %s', (name, type) => {
    expect(recordingProblem(file(name, type))).toMatch(/Choose a recording/)
  })

  it('turns away empty and oversized recordings', () => {
    expect(recordingProblem(file('a.mp3', 'audio/mpeg', 0))).toMatch(/empty/)
    expect(
      recordingProblem(file('a.wav', 'audio/wav', MAX_RECORDING_MB * 1024 * 1024 + 1)),
    ).toMatch(/larger than 100 MB/)
  })
})

describe('callEpisodes', () => {
  it('merges consecutive windows that heard a call', () => {
    expect(callEpisodes(windows(0.1, 0.9, 0.7, 0.2, 0.6), 0.5)).toEqual([
      { start: 3, end: 9, peak: 0.9, windows: 2 },
      { start: 12, end: 15, peak: 0.6, windows: 1 },
    ])
  })

  it('counts a window exactly at the threshold as a call', () => {
    expect(callEpisodes(windows(0.5), 0.5)).toHaveLength(1)
  })

  it('finds nothing in silence', () => {
    expect(callEpisodes(windows(0.1, 0.2), 0.5)).toEqual([])
    expect(callEpisodes([], 0.5)).toEqual([])
  })
})

describe('formatClock', () => {
  it.each([
    [0, '0:00'],
    [7.9, '0:07'],
    [185, '3:05'],
    [3729, '1:02:09'],
    [-2, '0:00'],
  ])('%s seconds reads %s', (seconds, clock) => {
    expect(formatClock(seconds)).toBe(clock)
  })
})

it('pluralizes calls', () => {
  expect(pluralizeCalls(1)).toBe('1 loon call')
  expect(pluralizeCalls(3)).toBe('3 loon calls')
})

it('writes the CSV loonet writes, one row per window', () => {
  expect(windowsCsv('a "lake".mp3', windows(0.91234, 0.1), 0.5)).toBe(
    'file,start_s,end_s,p_loon,loon\n' +
      '"a ""lake"".mp3",0.0,3.0,0.912,1\n' +
      '"a ""lake"".mp3",3.0,6.0,0.100,0\n',
  )
})
