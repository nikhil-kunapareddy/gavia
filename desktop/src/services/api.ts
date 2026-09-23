/**
 * The one place that talks to Gavia's Rust core.
 *
 * Inside the app every call is a Tauri `invoke`. In a plain browser
 * (`npm run dev` without the app) there is no core to talk to, so calls are
 * answered by the sample backend in `dev/browserPreview.ts` instead, which is
 * enough to work on screens without building any Rust.
 */

import { invoke } from '@tauri-apps/api/core'

/** An error the core described, with the code the UI branches on. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** What every Rust command rejects with; see `src-tauri/src/error.rs`. */
interface CoreError {
  code: string
  message: string
  status: number
  requestId?: string
}

function isCoreError(value: unknown): value is CoreError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CoreError).code === 'string' &&
    typeof (value as CoreError).message === 'string'
  )
}

/** True inside the app, where a Rust core is listening. */
export function inApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export type Args = Record<string, unknown> | Uint8Array

/**
 * Invoke a command and turn any failure into an `ApiError`.
 *
 * A rejection that is not the core's own error shape means the call never
 * reached a command at all — a missing command or a broken IPC bridge — which
 * no reviewer can act on, so it becomes `INTERNAL_ERROR`.
 */
export async function call<T>(command: string, args?: Args): Promise<T> {
  try {
    if (!inApp()) {
      const { previewCall } = await import('../dev/browserPreview')
      return await previewCall<T>(command, args)
    }
    return await invoke<T>(command, args)
  } catch (cause) {
    if (cause instanceof ApiError) throw cause
    if (isCoreError(cause)) {
      throw new ApiError(cause.code, cause.message, cause.status ?? 0, cause.requestId)
    }
    throw new ApiError('INTERNAL_ERROR', 'Something went wrong inside Gavia.', 0)
  }
}

/**
 * Pack JSON metadata and a file into one binary `invoke` body.
 *
 * Layout: little-endian u32 length, that many bytes of UTF-8 JSON, then the
 * file. Mirrors `unframe` in `src-tauri/src/service.rs`; a 20MB photo never
 * passes through a JSON encoder this way.
 */
export async function frame(meta: unknown, file: Blob): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(meta))
  const bytes = new Uint8Array(await readBytes(file))
  const body = new Uint8Array(4 + json.length + bytes.length)
  new DataView(body.buffer).setUint32(0, json.length, true)
  body.set(json, 4)
  body.set(bytes, 4 + json.length)
  return body
}

/** The inverse of `frame`, for the fakes that stand in for the core. */
export function unframe<T>(body: Uint8Array): { meta: T; bytes: Uint8Array } {
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true)
  const meta = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length))) as T
  return { meta, bytes: body.subarray(4 + length) }
}

/** `Blob.arrayBuffer`, with a FileReader fallback for jsdom, which lacks it. */
function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'))
    reader.readAsArrayBuffer(file)
  })
}
