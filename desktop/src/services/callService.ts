import type { CallResult } from '../types/calls'
import { call, frame } from './api'

/**
 * Listen for loon calls in one recording.
 *
 * Like a photo check, nothing is stored. The caller plays the recording from
 * its own object URL, which it already has.
 */
export async function analyzeRecording(file: File): Promise<CallResult> {
  const body = await frame({ fileName: file.name, contentType: file.type }, file)
  return call<CallResult>('detect_calls', body)
}
