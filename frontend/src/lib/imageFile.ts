/** Reads a File into a base64 data URL. Rejects if the read fails or is aborted. */
export function imageToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      // readAsDataURL always yields a string, but the type is widened to
      // include ArrayBuffer for the other read methods.
      const { result } = reader
      if (typeof result === 'string') resolve(result)
      else reject(new Error('Could not read the image file as a data URL.'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image file.'))
    reader.onabort = () => reject(new Error('Reading the image file was cancelled.'))
    reader.readAsDataURL(file)
  })
}

/** Revokes an object URL, ignoring anything that is not a blob: URL. */
export function revokeIfObjectUrl(url: string | null): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
}
