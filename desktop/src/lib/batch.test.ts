import { strToU8, zipSync, type Zippable } from 'fflate'
import { describe, expect, it } from 'vitest'
import { MAX_IMAGE_BYTES, describeSkipped, isZip, selectImages, type Selection } from './batch'
import { readBytes } from './imageFile'

function image(name = 'loon.jpg', type = 'image/jpeg', size?: number) {
  const file = new File(['image-bytes'], name, { type })
  // File size is read-only, and the size rules need big ones.
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size })
  return file
}

function zipBytes(entries: Record<string, string | Uint8Array>): Uint8Array {
  const zippable: Zippable = {}
  for (const [path, content] of Object.entries(entries)) {
    zippable[path] = typeof content === 'string' ? strToU8(content) : content
  }
  return zipSync(zippable)
}

function zipFile(bytes: Uint8Array, name = 'photos.zip', type = 'application/zip') {
  return new File([bytes as Uint8Array<ArrayBuffer>], name, { type })
}

function zipOf(entries: Record<string, string | Uint8Array>, name?: string) {
  return zipFile(zipBytes(entries), name)
}

/** Overwrite a field of the (first) entry in a zip's central directory. */
function patchCentralDirectory(zip: Uint8Array, offset: number, value: number, width: 2 | 4) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  for (let i = zip.length - 4; i >= 0; i--) {
    if (view.getUint32(i, true) !== 0x02014b50) continue
    if (width === 2) view.setUint16(i + offset, value, true)
    else view.setUint32(i + offset, value, true)
    return zip
  }
  throw new Error('no central directory')
}

function accepted(selection: Selection) {
  if (!selection.ok) throw new Error(`refused: ${selection.message}`)
  return selection
}

function refusal(selection: Selection) {
  if (selection.ok) throw new Error('expected the selection to be refused')
  return selection.message
}

describe('plain images', () => {
  it('keeps them in the order chosen', async () => {
    const files = [image('b.jpg'), image('a.png', 'image/png'), image('c.webp', 'image/webp')]

    const { images, skipped } = accepted(await selectImages(files))

    expect(images).toEqual(files)
    expect(skipped).toEqual([])
  })

  it('explains a single unsupported file', async () => {
    expect(refusal(await selectImages([image('x.gif', 'image/gif')]))).toMatch(/isn't supported/)
  })

  it('explains a single file over 20 MB', async () => {
    const huge = image('huge.jpg', 'image/jpeg', MAX_IMAGE_BYTES + 1)
    expect(refusal(await selectImages([huge]))).toMatch(/too large/)
  })

  it('accepts a file of exactly 20 MB', async () => {
    const big = image('big.jpg', 'image/jpeg', MAX_IMAGE_BYTES)
    expect(accepted(await selectImages([big])).images).toEqual([big])
  })

  it('leaves out what it cannot check and says so', async () => {
    const good = image('good.jpg')
    const { images, skipped } = accepted(
      await selectImages([
        good,
        image('notes.txt', 'text/plain'),
        image('huge.jpg', 'image/jpeg', MAX_IMAGE_BYTES + 1),
      ]),
    )

    expect(images).toEqual([good])
    expect(skipped).toEqual([
      { name: 'notes.txt', reason: 'format' },
      { name: 'huge.jpg', reason: 'size' },
    ])
  })

  it('refuses several files when none can be checked', async () => {
    const message = refusal(
      await selectImages([image('a.gif', 'image/gif'), image('b.txt', 'text/plain')]),
    )
    expect(message).toMatch(/None of these files/)
  })
})

describe('zips', () => {
  it('recognises a zip by type or by name', () => {
    expect(isZip(zipFile(new Uint8Array(), 'a.zip'))).toBe(true)
    expect(isZip(zipFile(new Uint8Array(), 'a', 'application/x-zip-compressed'))).toBe(true)
    expect(isZip(zipFile(new Uint8Array(), 'A.ZIP', ''))).toBe(true)
    expect(isZip(image())).toBe(false)
  })

  it('unpacks the images, named and typed from the entry, in natural order', async () => {
    const zip = zipOf({
      'trip/IMG_10.JPG': 'ten',
      'trip/IMG_2.jpeg': 'two',
      'shore.png': 'png',
      'lake.webp': 'webp',
    })

    const { images, skipped } = accepted(await selectImages([zip]))

    expect(images.map((file) => [file.name, file.type])).toEqual([
      ['lake.webp', 'image/webp'],
      ['shore.png', 'image/png'],
      ['IMG_2.jpeg', 'image/jpeg'],
      ['IMG_10.JPG', 'image/jpeg'],
    ])
    expect(new TextDecoder().decode(await readBytes(images[0]))).toBe('webp')
    expect(skipped).toEqual([])
  })

  it('ignores folders and macOS clutter without listing them', async () => {
    const zip = zipOf({
      'trip/': new Uint8Array(),
      'trip/loon.jpg': 'loon',
      '__MACOSX/trip/._loon.jpg': 'resource fork',
      'trip/.DS_Store': 'finder',
    })

    const { images, skipped } = accepted(await selectImages([zip]))

    expect(images.map((file) => file.name)).toEqual(['loon.jpg'])
    expect(skipped).toEqual([])
  })

  it('lists other files in the zip as left out, zips inside it included', async () => {
    const zip = zipOf({ 'loon.jpg': 'loon', 'notes.txt': 'notes', 'more.zip': 'zip', raw: 'x' })

    const { skipped } = accepted(await selectImages([zip]))

    expect(skipped).toEqual([
      { name: 'notes.txt', reason: 'format' },
      { name: 'more.zip', reason: 'format' },
      { name: 'raw', reason: 'format' },
    ])
  })

  it('leaves out an entry whose header says it is over 20 MB, without inflating it', async () => {
    const zip = zipOf({ 'loon.jpg': 'loon', 'huge.jpg': new Uint8Array(MAX_IMAGE_BYTES + 1) })

    const { images, skipped } = accepted(await selectImages([zip]))

    expect(images.map((file) => file.name)).toEqual(['loon.jpg'])
    expect(skipped).toEqual([{ name: 'huge.jpg', reason: 'size' }])
  })

  it('measures a stored entry again, since its header can understate it', async () => {
    const stored = zipSync({ 'huge.jpg': [new Uint8Array(MAX_IMAGE_BYTES + 1), { level: 0 }] })
    // Uncompressed size, which the filter trusts.
    patchCentralDirectory(stored, 24, 1000, 4)

    const message = refusal(await selectImages([zipFile(stored)]))

    expect(message).toMatch(/no JPG, PNG, or WEBP images/)
  })

  it('leaves out an entry compressed in a way it cannot read', async () => {
    // 99 is what an AES-encrypted entry reports as its method.
    const zip = patchCentralDirectory(zipBytes({ 'secret.jpg': 'x' }), 10, 99, 2)

    const message = refusal(await selectImages([zipFile(zip)]))

    expect(message).toMatch(/no JPG, PNG, or WEBP images/)
  })

  it('explains a zip that cannot be opened', async () => {
    const broken = zipFile(strToU8('not a zip at all'))
    expect(refusal(await selectImages([broken]))).toMatch(/could not be opened/)
  })

  it('leaves out a broken zip among other files', async () => {
    const good = image()
    const broken = zipFile(strToU8('not a zip at all'), 'broken.zip')

    const { images, skipped } = accepted(await selectImages([good, broken]))

    expect(images).toEqual([good])
    expect(skipped).toEqual([{ name: 'broken.zip', reason: 'unreadable' }])
  })

  it('refuses a zip over 500 MB without reading it', async () => {
    const zip = zipOf({ 'loon.jpg': 'loon' })
    Object.defineProperty(zip, 'size', { value: 500 * 1024 * 1024 + 1 })

    expect(refusal(await selectImages([zip]))).toMatch(/zip is too large/)
  })

  it('explains a zip with no images in it', async () => {
    expect(refusal(await selectImages([zipOf({ 'notes.txt': 'x' })]))).toMatch(/no JPG/)
  })
})

describe('the 25-image limit', () => {
  const images = (count: number) => Array.from({ length: count }, (_, i) => image(`${i}.jpg`))
  const zipOfImages = (count: number, name?: string) =>
    zipOf(Object.fromEntries(Array.from({ length: count }, (_, i) => [`${i}.jpg`, 'x'])), name)

  it('takes exactly 25', async () => {
    expect(accepted(await selectImages(images(25))).images).toHaveLength(25)
  })

  it('refuses 26 rather than guessing which to leave out', async () => {
    expect(refusal(await selectImages(images(26)))).toBe(
      "That's 26 images. You can check up to 25 at a time.",
    )
  })

  it('counts what is inside zips', async () => {
    expect(refusal(await selectImages([zipOfImages(30)]))).toMatch(/That's 30 images/)
  })

  it('counts across images and zips together', async () => {
    const selection = await selectImages([...images(20), zipOfImages(5, 'a.zip')])
    expect(accepted(selection).images).toHaveLength(25)

    const over = await selectImages([...images(20), zipOfImages(5, 'a.zip'), zipOfImages(3)])
    expect(refusal(over)).toMatch(/That's 28 images/)
  })

  it('does not count what it leaves out', async () => {
    const selection = await selectImages([...images(25), image('notes.txt', 'text/plain')])
    expect(accepted(selection).skipped).toHaveLength(1)
  })
})

describe('describing what was left out', () => {
  it('says nothing when nothing was', () => {
    expect(describeSkipped([])).toBe('')
  })

  it('names a single file by its own name, not its path in the zip', () => {
    expect(describeSkipped([{ name: 'trip/notes.txt', reason: 'format' }])).toBe(
      "Left out 1 file Gavia can't check: notes.txt.",
    )
  })

  it('names the first three and counts the rest', () => {
    const skipped = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map((name) => ({
      name,
      reason: 'format' as const,
    }))
    expect(describeSkipped(skipped)).toBe(
      "Left out 5 files Gavia can't check: a.txt, b.txt, c.txt and 2 more.",
    )
  })
})
