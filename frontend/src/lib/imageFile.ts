/**
 * Revokes an object URL, ignoring anything that is not a blob: URL.
 *
 * Result images can be either a `blob:` preview of a local file or an
 * `/api/results/...` URL once saved, and only the former needs revoking.
 */
export function revokeIfObjectUrl(url: string | null): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
}
