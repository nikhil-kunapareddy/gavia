import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioUploader } from './AudioUploader'

const onFile = vi.fn()
const onRemove = vi.fn()

beforeEach(() => {
  onFile.mockReset()
  onRemove.mockReset()
})

function renderUploader(overrides = {}) {
  return render(
    <AudioUploader
      file={null}
      audioUrl={null}
      onFile={onFile}
      onRemove={onRemove}
      {...overrides}
    />,
  )
}

function input() {
  return document.querySelector('input[type="file"]') as HTMLInputElement
}

const recording = () => new File(['audio'], 'lake.mp3', { type: 'audio/mpeg' })

describe('choosing a recording', () => {
  it('hands over a recording chosen from the device', async () => {
    const user = userEvent.setup()
    renderUploader()

    await user.upload(input(), recording())

    expect(onFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'lake.mp3' }))
  })

  it('accepts a recording dropped on it', () => {
    renderUploader()

    fireEvent.drop(screen.getByText(/Drop a recording here/).parentElement!, {
      dataTransfer: { files: [recording()] },
    })

    expect(onFile).toHaveBeenCalledTimes(1)
  })

  it('explains why a photo is not a recording', () => {
    renderUploader()

    fireEvent.drop(screen.getByText(/Drop a recording here/).parentElement!, {
      dataTransfer: { files: [new File(['x'], 'loon.jpg', { type: 'image/jpeg' })] },
    })

    expect(screen.getByRole('alert')).toHaveTextContent(/Choose a recording/)
    expect(onFile).not.toHaveBeenCalled()
  })

  it('takes one recording at a time', () => {
    renderUploader()

    fireEvent.drop(screen.getByText(/Drop a recording here/).parentElement!, {
      dataTransfer: { files: [recording(), recording()] },
    })

    expect(screen.getByRole('alert')).toHaveTextContent(/one recording at a time/)
    expect(onFile).not.toHaveBeenCalled()
  })

  it('shows the drop target while something is dragged over it', () => {
    renderUploader()
    const zone = screen.getByText(/Drop a recording here/).parentElement!

    fireEvent.dragOver(zone)
    expect(zone.className).toContain('drop-zone-active')
    fireEvent.dragLeave(zone)
    expect(zone.className).not.toContain('drop-zone-active')
  })
})

describe('once a recording is chosen', () => {
  const chosen = { file: recording(), audioUrl: 'blob:lake' }

  it('shows it with a player', () => {
    renderUploader(chosen)

    expect(screen.getByText('lake.mp3')).toBeInTheDocument()
    expect(document.querySelector('audio')).toHaveAttribute('src', 'blob:lake')
  })

  it('removes it when asked', async () => {
    const user = userEvent.setup()
    renderUploader(chosen)

    await user.click(screen.getByRole('button', { name: 'Remove selected recording' }))

    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('swaps it for another', async () => {
    const user = userEvent.setup()
    renderUploader(chosen)

    await user.click(screen.getByRole('button', { name: 'Change recording' }))
    await user.upload(input(), new File(['b'], 'night.wav', { type: 'audio/wav' }))

    expect(onFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'night.wav' }))
  })

  it('still explains a bad replacement', async () => {
    const user = userEvent.setup({ applyAccept: false })
    renderUploader(chosen)

    await user.upload(input(), new File(['x'], 'notes.txt', { type: 'text/plain' }))

    expect(screen.getByRole('alert')).toHaveTextContent(/Choose a recording/)
  })
})
