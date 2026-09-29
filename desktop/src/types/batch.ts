import type { DetectionResult } from './detection'

export type BatchStatus = 'waiting' | 'checking' | 'done' | 'failed'

/** One image in a batch check. */
export interface BatchItem {
  /** Unique within the batch; file names need not be. */
  key: string
  file: File
  /** Object URL of `file`, for the grid and for the result until it is saved. */
  previewUrl: string
  status: BatchStatus
  result?: DetectionResult
  /** Why the check failed, in words the reviewer can act on. */
  error?: string
  saving?: boolean
}

/** What the batch is doing, if anything. It does one thing at a time. */
export type BatchBusy = 'checking' | 'stopping' | 'saving' | null
