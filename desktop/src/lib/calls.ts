import type { CallWindow } from '../types/calls'

/** Matches `max_audio_bytes` in `src-tauri/src/config.rs`, so both say the same. */
export const MAX_RECORDING_MB = 100

/** What the core decodes; a video's audio track counts as a recording. */
const RECORDING_EXTENSIONS = ['.wav', '.mp3', '.flac', '.ogg', '.oga', '.m4a', '.mp4', '.mov']
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'application/ogg']

/** The file picker's `accept`. */
export const RECORDING_ACCEPT = ['audio/*', ...VIDEO_TYPES, ...RECORDING_EXTENSIONS].join(',')

export const RECORDING_FORMATS = 'WAV, MP3, FLAC, OGG or M4A'

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

/**
 * Why a file can't be listened to, or null if it can. The core sniffs the
 * bytes regardless; this only turns away the obvious before a long upload.
 */
export function recordingProblem(file: File): string | null {
  const type = file.type.toLowerCase()
  const looksLikeAudio =
    type.startsWith('audio/') ||
    VIDEO_TYPES.includes(type) ||
    RECORDING_EXTENSIONS.includes(extension(file.name))
  if (!looksLikeAudio) return `Choose a recording: ${RECORDING_FORMATS}.`
  if (file.size === 0) return 'That recording is empty.'
  if (file.size > MAX_RECORDING_MB * 1024 * 1024) {
    return `That recording is larger than ${MAX_RECORDING_MB} MB. Please split it into shorter files.`
  }
  return null
}

/** A run of consecutive windows that all heard a call. */
export interface CallEpisode {
  start: number
  end: number
  /** The most confident window in the run. */
  peak: number
  windows: number
}

/**
 * Consecutive windows at or above the threshold, merged: a loon's wail often
 * outlasts one 3-second window, and it is one call to the reviewer.
 */
export function callEpisodes(windows: CallWindow[], threshold: number): CallEpisode[] {
  const episodes: CallEpisode[] = []
  let current: CallEpisode | null = null
  for (const window of windows) {
    if (window.confidence < threshold) {
      current = null
      continue
    }
    if (current) {
      current.end = window.end
      current.peak = Math.max(current.peak, window.confidence)
      current.windows += 1
    } else {
      current = { start: window.start, end: window.end, peak: window.confidence, windows: 1 }
      episodes.push(current)
    }
  }
  return episodes
}

/** Seconds as a clock: 0:07, 3:05, 1:02:09. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = String(whole % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** "1 loon call" / "3 loon calls" */
export function pluralizeCalls(count: number): string {
  return `${count} loon ${count === 1 ? 'call' : 'calls'}`
}

/** One row per window, the columns loonet's detect_loon_calls.py writes. */
export function windowsCsv(fileName: string, windows: CallWindow[], threshold: number): string {
  const quoted = `"${fileName.replace(/"/g, '""')}"`
  const rows = windows.map((w) =>
    [
      quoted,
      w.start.toFixed(1),
      w.end.toFixed(1),
      w.confidence.toFixed(3),
      w.confidence >= threshold ? 1 : 0,
    ].join(','),
  )
  return ['file,start_s,end_s,p_loon,loon', ...rows].join('\n') + '\n'
}
