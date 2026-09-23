import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageUploader } from './ImageUploader'

function imageFile(name = 'loon.jpg', type = 'image/jpeg', size = 1024) {
  const file = new File(['x'], name, { type })
  // File size is read-only, and the uploader's 20MB rule needs a big one.
  Object.defineProperty(file, 'size', { value: size })
  return file
}

const onFile = vi.fn()
const onRemove = vi.fn()

beforeEach(() => {
  onFile.mockReset()
  onRemove.mockReset()
})

function renderEmpty() {
  return render(<ImageUploader file={null} previewUrl={null} onFile={onFile} onRemove={onRemove} />)
}

function renderWithFile(file = imageFile()) {
  return render(
    <ImageUploader file={file} previewUrl="blob:preview" onFile={onFile} onRemove={onRemove} />,
  )
}

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement
}

describe('choosing a file', () => {
  it('accepts a JPEG', async () => {
    const user = userEvent.setup()
    const { container } = renderEmpty()

    await user.upload(fileInput(container), imageFile())

    expect(onFile).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['image/png', 'loon.png'],
    ['image/webp', 'loon.webp'],
  ])('accepts %s', async (type, name) => {
    const user = userEvent.setup()
    const { container } = renderEmpty()

    await user.upload(fileInput(container), imageFile(name, type))

    expect(onFile).toHaveBeenCalledTimes(1)
  })

  it('rejects an unsupported type with a message instead of silently ignoring it', async () => {
    // applyAccept: false because the input's accept attribute would filter
    // this out before the handler ever saw it. A picker can still be
    // overridden ("All Files" on macOS) and drag-and-drop ignores accept
    // entirely, so the component has to do its own checking.
    const user = userEvent.setup({ applyAccept: false })
    const { container } = renderEmpty()

    await user.upload(fileInput(container), imageFile('notes.gif', 'image/gif'))

    expect(onFile).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/isn't supported/i)
  })

  it('rejects a file over 20MB', async () => {
    const user = userEvent.setup()
    const { container } = renderEmpty()

    await user.upload(fileInput(container), imageFile('huge.jpg', 'image/jpeg', 21 * 1024 * 1024))

    expect(onFile).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/too large/i)
  })

  it('accepts a file just under the limit', async () => {
    const user = userEvent.setup()
    const { container } = renderEmpty()

    await user.upload(
      fileInput(container),
      imageFile('big.jpg', 'image/jpeg', 20 * 1024 * 1024 - 1),
    )

    expect(onFile).toHaveBeenCalledTimes(1)
  })

  it('clears a previous error once a good file arrives', async () => {
    const user = userEvent.setup({ applyAccept: false })
    const { container } = renderEmpty()

    await user.upload(fileInput(container), imageFile('bad.gif', 'image/gif'))
    expect(screen.getByRole('alert')).toBeInTheDocument()

    await user.upload(fileInput(container), imageFile())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('states the accepted formats and size up front', () => {
    renderEmpty()
    expect(screen.getByText(/JPG, PNG, or WEBP · up to 20 MB/)).toBeInTheDocument()
  })
})

describe('drag and drop', () => {
  it('accepts a dropped image', () => {
    renderEmpty()
    const zone = document.querySelector('.drop-zone') as HTMLElement

    fireEvent.drop(zone, { dataTransfer: { files: [imageFile()] } })

    expect(onFile).toHaveBeenCalledTimes(1)
  })

  it('validates a dropped file the same way as a chosen one', () => {
    renderEmpty()
    const zone = document.querySelector('.drop-zone') as HTMLElement

    fireEvent.drop(zone, { dataTransfer: { files: [imageFile('x.gif', 'image/gif')] } })

    expect(onFile).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('highlights the zone while dragging and stops when the pointer leaves', () => {
    renderEmpty()
    const zone = document.querySelector('.drop-zone') as HTMLElement

    fireEvent.dragOver(zone)
    expect(zone.className).toContain('drop-zone-active')

    fireEvent.dragLeave(zone)
    expect(zone.className).not.toContain('drop-zone-active')
  })

  it('stops highlighting after a drop', () => {
    renderEmpty()
    const zone = document.querySelector('.drop-zone') as HTMLElement

    fireEvent.dragOver(zone)
    fireEvent.drop(zone, { dataTransfer: { files: [imageFile()] } })

    expect(zone.className).not.toContain('drop-zone-active')
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
