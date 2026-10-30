import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { CallResult as Result } from '../types/calls'
import { CallResult } from './CallResult'

const onCheckAnother = vi.fn()
let play: MockInstance<() => Promise<void>>

beforeEach(() => {
  onCheckAnother.mockReset()
  // jsdom has no media playback.
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
})

function result(confidences: number[], overrides: Partial<Result> = {}): Result {
  return {
    id: 'abc',
    fileName: 'lake.mp3',
    fileSize: 2048,
    duration: confidences.length * 3,
    sampleRate: 44100,
    channels: 2,
    windows: confidences.map((confidence, index) => ({
      start: index * 3,
      end: index * 3 + 3,
      confidence,
    })),
    threshold: 0.5,
    label: 'Loon call',
    modelName: 'looncall 1.0',
    processingTime: 0.42,
    timestamp: '2026-10-30T10:00:00+00:00',
    ...overrides,
  }
}

function renderResult(r: Result, audioUrl: string | null = 'blob:lake') {
  return render(<CallResult result={r} audioUrl={audioUrl} onCheckAnother={onCheckAnother} />)
}

function audio() {
  return document.querySelector('audio') as HTMLAudioElement
}

describe('a recording with calls', () => {
  const heard = result([
    0.1, 0.92, 0.8, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2,
    0.2, 0.61,
  ])

  it('counts calls, not windows', () => {
    renderResult(heard)

    expect(screen.getByRole('heading', { name: '2 loon calls heard' })).toBeInTheDocument()
    expect(screen.getByText(/heard in 3 of 21 three-second stretches/)).toBeInTheDocument()
    const strongest = document.querySelector('.confidence-card') as HTMLElement
    expect(within(strongest).getByText('92%')).toBeInTheDocument()
  })

  it('plays a call from its start', async () => {
    const user = userEvent.setup()
    renderResult(heard)

    await user.click(screen.getByRole('button', { name: /Play call 2, 1:00 to 1:03, 61%/ }))

    expect(audio().currentTime).toBe(60)
    expect(play).toHaveBeenCalled()
  })

  it('plays from wherever the timeline is clicked', () => {
    renderResult(heard)
    const timeline = document.querySelector('.call-timeline') as HTMLElement
    vi.spyOn(timeline, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      width: 630,
    } as DOMRect)

    fireEvent.click(timeline, { clientX: 400 })

    // 300 of 630 pixels into a 63-second recording.
    expect(audio().currentTime).toBeCloseTo(30)
  })

  it('moves the playhead as the recording plays', () => {
    renderResult(heard)
    audio().currentTime = 31.5
    fireEvent.timeUpdate(audio())

    expect((document.querySelector('.call-playhead') as HTMLElement).style.left).toBe('50%')
  })

  it('downloads every window as CSV', async () => {
    const user = userEvent.setup()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderResult(heard)

    await user.click(screen.getByRole('button', { name: /Download CSV/ }))

    const link = click.mock.contexts[0] as HTMLAnchorElement
    expect(link.download).toBe('loon-calls-lake.csv')
    const csv = decodeURIComponent(link.href.split(',').slice(1).join(','))
    expect(csv.trim().split('\n')).toHaveLength(22)
    expect(csv).toContain('"lake.mp3",3.0,6.0,0.920,1')
  })

  it('describes the audio', async () => {
    const user = userEvent.setup()
    renderResult(heard)

    await user.click(screen.getByText('View details'))

    const details = within(document.querySelector('dl') as HTMLElement)
    expect(details.getByText('44.1 kHz, 2 channels')).toBeInTheDocument()
    expect(details.getByText('1:03')).toBeInTheDocument()
  })
})

describe('a recording without calls', () => {
  it('says so and offers another try', async () => {
    const user = userEvent.setup()
    renderResult(result([0.1, 0.2]))

    expect(screen.getByRole('heading', { name: 'No loon calls heard' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Try another recording/ }))
    expect(onCheckAnother).toHaveBeenCalledTimes(1)
  })
})

describe('when the recording cannot be played here', () => {
  it('keeps the timeline and says why there is no player', () => {
    renderResult(result([0.9]))
    fireEvent.error(audio())

    expect(document.querySelector('audio')).toBeNull()
    expect(screen.getByText(/can't be played here/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Play call 1/ })).toBeDisabled()
  })

  it('stops offering playback if playing fails', async () => {
    play.mockRejectedValue(new Error('no codec'))
    const user = userEvent.setup()
    renderResult(result([0.9]))

    await user.click(screen.getByRole('button', { name: /Play call 1/ }))

    expect(await screen.findByText(/can't be played here/)).toBeInTheDocument()
  })

  it('has nothing to play without the original file', () => {
    renderResult(result([0.9]), null)

    expect(document.querySelector('audio')).toBeNull()
    expect(screen.getByRole('button', { name: /Play call 1/ })).toBeDisabled()
  })
})

it('goes back to choose another recording', async () => {
  const user = userEvent.setup()
  renderResult(result([0.9]))

  await user.click(screen.getByRole('button', { name: /Check another recording/ }))

  expect(onCheckAnother).toHaveBeenCalledTimes(1)
})
