import { unzipSync } from 'fflate'
import { readBytes } from './imageFile'

/** How many images one check can take, counting what is inside zips. */
export const MAX_BATCH_IMAGES = 25

/** Per image. Matches `max_upload_bytes` in `src-tauri/src/config.rs`. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** A zip that could hold a full batch, and no more. */
export const MAX_ZIP_BYTES = MAX_BATCH_IMAGES * MAX_IMAGE_BYTES

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

const TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

// Stored and deflated: the only two methods fflate reads. Anything else
// (AES encryption reports 99) is skipped rather than failing the whole zip.
const READABLE_COMPRESSION = [0, 8]

const UNSUPPORTED = "This image format isn't supported. Please upload a JPG, PNG, or WEBP image."
const TOO_LARGE = 'This image is too large. Please choose an image smaller than 20 MB.'
const UNREADABLE_ZIP = 'This zip file could not be opened.'
const ZIP_TOO_LARGE = 'This zip is too large. Zips can be up to 500 MB.'
const EMPTY_ZIP = 'This zip has no JPG, PNG, or WEBP images under 20 MB.'
const NOTHING_USABLE = 'None of these files are JPG, PNG, or WEBP images under 20 MB.'

export type SkipReason = 'format' | 'size' | 'unreadable'

/** A file, or a zip entry, that was left out of a selection. */
export interface Skipped {
  name: string
  reason: SkipReason
}

export type Selection =
  { ok: true; images: File[]; skipped: Skipped[] } | { ok: false; message: string }

export function isZip(file: File): boolean {
  return (
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed' ||
    /\.zip$/i.test(file.name)
  )
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function typeFromName(name: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  return extension ? TYPE_BY_EXTENSION[extension] : undefined
}

/** Folders and the clutter macOS and other tools add to zips. */
function isClutter(path: string): boolean {
  return path.endsWith('/') || path.startsWith('__MACOSX/') || baseName(path).startsWith('.')
}

/**
 * Pull the images out of one zip.
 *
 * Counts every image it finds but only extracts the first `room`, so a zip
 * that would overflow the batch is measured without holding all of it.
 * Entry sizes come from the zip's own headers, which can lie: a deflated
 * entry is inflated into a buffer of the declared size, so it can't grow past
 * it, and a stored one is measured again once read.
 */
async function unpack(
  zip: File,
  room: number,
): Promise<{ found: number; images: File[]; skipped: Skipped[] }> {
  if (zip.size > MAX_ZIP_BYTES) {
    return { found: 0, images: [], skipped: [{ name: zip.name, reason: 'size' }] }
  }
  const skipped: Skipped[] = []
  let found = 0
  let entries: Record<string, Uint8Array>
  try {
    const data = new Uint8Array(await readBytes(zip))
    entries = unzipSync(data, {
      filter: (entry) => {
        if (isClutter(entry.name)) return false
        if (!typeFromName(entry.name) || !READABLE_COMPRESSION.includes(entry.compression)) {
          skipped.push({ name: entry.name, reason: 'format' })
          return false
        }
        if (entry.originalSize > MAX_IMAGE_BYTES) {
          skipped.push({ name: entry.name, reason: 'size' })
          return false
        }
        found += 1
        return found <= room
      },
    })
  } catch {
    return { found: 0, images: [], skipped: [{ name: zip.name, reason: 'unreadable' }] }
  }

  const images: File[] = []
  const paths = Object.keys(entries).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  )
  for (const path of paths) {
    const bytes = entries[path]
    if (bytes.length > MAX_IMAGE_BYTES) {
      skipped.push({ name: path, reason: 'size' })
      found -= 1
      continue
    }
    images.push(
      new File([bytes as Uint8Array<ArrayBuffer>], baseName(path), { type: typeFromName(path) }),
    )
  }
  return { found, images, skipped }
}

/** Why a selection with no usable images was turned away. */
function emptyMessage(files: File[], skipped: Skipped[]): string {
  if (files.length > 1) return NOTHING_USABLE
  const [file] = files
  const own = skipped.find((item) => item.name === file.name)
  if (!isZip(file)) return own?.reason === 'size' ? TOO_LARGE : UNSUPPORTED
  if (own?.reason === 'unreadable') return UNREADABLE_ZIP
  if (own?.reason === 'size') return ZIP_TOO_LARGE
  return EMPTY_ZIP
}

/**
 * Turn what the reviewer picked or dropped — images, zips of images, or both —
 * into the images to check.
 *
 * Files that can't be checked are left out and listed in `skipped`. A
 * selection over `MAX_BATCH_IMAGES` is refused outright rather than cut
 * short, because which images got left out would be a guess.
 */
export async function selectImages(files: File[]): Promise<Selection> {
  const images: File[] = []
  const skipped: Skipped[] = []
  let found = 0

  for (const file of files) {
    if (isZip(file)) {
      const unpacked = await unpack(file, MAX_BATCH_IMAGES - found)
      found += unpacked.found
      images.push(...unpacked.images)
      skipped.push(...unpacked.skipped)
    } else if (!IMAGE_TYPES.includes(file.type)) {
      skipped.push({ name: file.name, reason: 'format' })
    } else if (file.size > MAX_IMAGE_BYTES) {
      skipped.push({ name: file.name, reason: 'size' })
    } else {
      found += 1
      if (found <= MAX_BATCH_IMAGES) images.push(file)
    }
  }

  if (found > MAX_BATCH_IMAGES) {
    return {
      ok: false,
      message: `That's ${found} images. You can check up to ${MAX_BATCH_IMAGES} at a time.`,
    }
  }
  if (images.length === 0) return { ok: false, message: emptyMessage(files, skipped) }
  return { ok: true, images, skipped }
}

/** One line naming what was left out, or '' when nothing was. */
export function describeSkipped(skipped: Skipped[]): string {
  if (skipped.length === 0) return ''
  const shown = skipped.slice(0, 3).map((item) => baseName(item.name))
  const more = skipped.length - shown.length
  const files = skipped.length === 1 ? '1 file' : `${skipped.length} files`
  return `Left out ${files} Gavia can't check: ${shown.join(', ')}${more ? ` and ${more} more` : ''}.`
}
