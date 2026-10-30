/** One 3-second stretch of a recording. */
export interface CallWindow {
  /** Seconds into the recording. */
  start: number
  end: number
  /** How likely this window is to hold a loon call, 0-1. */
  confidence: number
}

/** What listening to one recording found. Mirrors `CallResult` in `service.rs`. */
export interface CallResult {
  id: string
  fileName: string
  fileSize: number
  /** Seconds of audio. */
  duration: number
  sampleRate: number
  channels: number
  /** Every window in order; the ones at or above `threshold` are calls. */
  windows: CallWindow[]
  threshold: number
  /** What a call is called, e.g. "Loon call". */
  label: string
  modelName: string
  /** Seconds spent decoding and listening, as measured by the core. */
  processingTime: number
  timestamp: string
}
