/**
 * Revokes an object URL, ignoring anything that is not a blob: URL.
 *
 * Result images can be either a `blob:` preview of a local file or
 * a `gavia://` URL once saved, and only the former needs revoking.
 */
export function revokeIfObjectUrl(url: string | null): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
}

/** `Blob.arrayBuffer`, with a FileReader fallback for jsdom, which lacks it. */
export function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'))
    reader.readAsArrayBuffer(file)
  })
}
