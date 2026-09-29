import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { strToU8, zipSync } from 'fflate'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageUploader } from './ImageUploader'

function imageFile(name = 'loon.jpg', type = 'image/jpeg', size = 1024) {
  const file = new File(['x'], name, { type })
  // File size is read-only, and the uploader's 20MB rule needs a big one.
  Object.defineProperty(file, 'size', { value: size })
  return file
}

const onFiles = vi.fn()
const onRemove = vi.fn()

beforeEach(() => {
  onFiles.mockReset()
  onRemove.mockReset()
})

function renderEmpty() {
  return render(
    <ImageUploader file={null} previewUrl={null} onFiles={onFiles} onRemove={onRemove} />,
  )
}

function renderWithFile(file = imageFile()) {
  return render(
    <ImageUploader file={file} previewUrl="blob:preview" onFiles={onFiles} onRemove={onRemove} />,
  )
}

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement
}

describe('choosing a file', () => {
  it('accepts a JPEG', async () => {
    const user = userEvent.setup()
    const { container } = renderEmpty()

    const file = imageFile()
    await user.upload(fileInput(container), file)

    await waitFor(() => expect(onFiles).toHaveBeenCalledWith([file], []))
  })

  it.each([
    ['image/png', 'loon.png'],
    ['image/webp', 'loon.webp'],
  ])('accepts %s', async (type, name) => {
    const user = userEvent.setup()
    const { container } = renderEmpty()

    await user.upload(fileInput(container), imageFile(name, type))

    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1))
  })

  it('rejects an unsupported type with a message instead of silently ignoring it', async () => {
    // applyAccept: false because the input's accept attribute would filter
    // this out before the handler ever saw it. A picker can still be
    // overridden ("All Files" on macOS) and drag-and-drop ignores accept
    // entirely, so the component has to do its own checking.
    const user = userEvent.setup({ applyAccept: false })
    const { container } = renderEmpty()

    await user.upload(fileInput(container), imageFile('notes.gif', 'image/gif'))

    expect(await screen.findByRole('alert')).toHaveTextContent(/isn't supported/i)
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('rejects a file over 20MB', async () => {
    const user = userEvent.setup()
    const { container } = renderEmpty()

    await user.upload(fileInput(container), imageFile('huge.jpg', 'image/jpeg', 21 * 1024 * 1024))

    expect(await screen.findByRole('alert')).toHaveTextContent(/too large/i)
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('accepts a file just under the limit', async () => {
    const user = userEvent.setup()
    const { container } = renderEmpty()

    await user.upload(
      fileInput(container),
      imageFile('big.jpg', 'image/jpeg', 20 * 1024 * 1024 - 1),
    )

    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1))
  })

  it('clears a previous error once a good file arrives', async () => {
    const user = userEvent.setup({ applyAccept: false })
    const { container } = renderEmpty()

    await user.upload(fileInput(container), imageFile('bad.gif', 'image/gif'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    await user.upload(fileInput(container), imageFile())
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('states the accepted formats and limits up front', () => {
    renderEmpty()
    expect(
      screen.getByText(/JPG, PNG, WEBP, or a ZIP of them · up to 25 images, 20 MB each/),
    ).toBeInTheDocument()
  })
})

describe('choosing several files', () => {
  it('passes every image on, and says what it left out', async () => {
    const user = userEvent.setup({ applyAccept: false })
    const { container } = renderEmpty()
    const first = imageFile('first.jpg')
    const second = imageFile('second.png', 'image/png')

    await user.upload(fileInput(container), [first, imageFile('notes.txt', 'text/plain'), second])

    await waitFor(() =>
      expect(onFiles).toHaveBeenCalledWith(
        [first, second],
        [{ name: 'notes.txt', reason: 'format' }],
      ),
    )
  })

  it('unpacks a zip', async () => {
    const user = userEvent.setup()
    const { container } = renderEmpty()
    const zip = new File([zipSync({ 'a.jpg': strToU8('a'), 'b.jpg': strToU8('b') })], 'trip.zip', {
      type: 'application/zip',
    })

    await user.upload(fileInput(container), zip)

    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1))
    const [images] = onFiles.mock.calls[0] as [File[]]
    expect(images.map((file) => file.name)).toEqual(['a.jpg', 'b.jpg'])
  })

  it('says so while a zip is being opened', async () => {
    renderEmpty()
    const zone = document.querySelector('.drop-zone') as HTMLElement
    const zip = new File([zipSync({ 'a.jpg': strToU8('a') })], 'trip.zip', {
      type: 'application/zip',
    })

    fireEvent.drop(zone, { dataTransfer: { files: [zip] } })

    expect(screen.getByRole('status')).toHaveTextContent('Opening the zip')
    expect(screen.getByRole('button', { name: /Upload photos/ })).toBeDisabled()
    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('refuses more than 25 images with a count', async () => {
    const user = userEvent.setup()
    const { container } = renderEmpty()
    const files = Array.from({ length: 26 }, (_, i) => imageFile(`${i}.jpg`))

    await user.upload(fileInput(container), files)

    expect(await screen.findByRole('alert')).toHaveTextContent(/That's 26 images/)
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('ignores an empty selection', async () => {
    const { container } = renderEmpty()

    fireEvent.change(fileInput(container), { target: { files: [] } })

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(onFiles).not.toHaveBeenCalled()
  })
})

describe('drag and drop', () => {
  it('accepts dropped images', async () => {
    renderEmpty()
    const zone = document.querySelector('.drop-zone') as HTMLElement
    const files = [imageFile('a.jpg'), imageFile('b.jpg')]

    fireEvent.drop(zone, { dataTransfer: { files } })

    await waitFor(() => expect(onFiles).toHaveBeenCalledWith(files, []))
  })

  it('validates a dropped file the same way as a chosen one', async () => {
    renderEmpty()
    const zone = document.querySelector('.drop-zone') as HTMLElement

    fireEvent.drop(zone, { dataTransfer: { files: [imageFile('x.gif', 'image/gif')] } })

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('highlights the zone while dragging and stops when the pointer leaves', () => {
    renderEmpty()
    const zone = document.querySelector('.drop-zone') as HTMLElement

    fireEvent.dragOver(zone)
    expect(zone.className).toContain('drop-zone-active')

    fireEvent.dragLeave(zone)
    expect(zone.className).not.toContain('drop-zone-active')
  })

  it('stops highlighting after a drop', async () => {
    renderEmpty()
    const zone = document.querySelector('.drop-zone') as HTMLElement

    fireEvent.dragOver(zone)
    fireEvent.drop(zone, { dataTransfer: { files: [imageFile()] } })

    expect(zone.className).not.toContain('drop-zone-active')
    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1))
  })
})

describe('once a file is chosen', () => {
  it('shows a preview with the file name and size', () => {
    renderWithFile(imageFile('nest.jpg', 'image/jpeg', 2 * 1024 * 1024))

    expect(screen.getByAltText('Preview of nest.jpg')).toBeInTheDocument()
    expect(screen.getByText('2.00 MB')).toBeInTheDocument()
  })

  it('offers a labelled way to remove it', async () => {
    const user = userEvent.setup()
    renderWithFile()

    await user.click(screen.getByRole('button', { name: 'Remove selected image' }))

    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('offers a way to swap the image without removing it first', () => {
    renderWithFile()
    expect(screen.getByRole('button', { name: 'Change image' })).toBeInTheDocument()
  })

  it('hides the drop zone', () => {
    renderWithFile()
    expect(document.querySelector('.drop-zone')).toBeNull()
  })
})
