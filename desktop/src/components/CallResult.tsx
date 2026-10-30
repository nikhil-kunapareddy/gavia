import { AudioLines, Download, FileText, Play, RotateCcw } from 'lucide-react'
import { useRef, useState, type MouseEvent } from 'react'
import { callEpisodes, formatClock, pluralizeCalls, windowsCsv } from '../lib/calls'
import { toPercent } from '../lib/format'
import type { CallResult as Result } from '../types/calls'

interface CallResultProps {
  result: Result
  /** The reviewer's own copy of the recording, for playback; nothing is stored. */
  audioUrl: string | null
  onCheckAnother: () => void
}

function downloadCsv(result: Result) {
  const csv = windowsCsv(result.fileName, result.windows, result.threshold)
  const link = document.createElement('a')
  link.download = `loon-calls-${result.fileName.replace(/\.[^.]+$/, '')}.csv`
  link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`
  link.click()
}

export function CallResult({ result, audioUrl, onCheckAnother }: CallResultProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [position, setPosition] = useState(0)
  const [playable, setPlayable] = useState(true)

  const episodes = callEpisodes(result.windows, result.threshold)
  const heard = result.windows.filter((w) => w.confidence >= result.threshold).length
  const found = episodes.length > 0
  const strongest = episodes.reduce((max, e) => Math.max(max, e.peak), 0)
  // The windows cover the recording; their last end is its length.
  const duration = Math.max(result.duration, result.windows.at(-1)?.end ?? 0, 1e-9)
  const percent = (seconds: number) => `${(seconds / duration) * 100}%`

  function playFrom(seconds: number) {
    const audio = audioRef.current
    if (!audio || !playable) return
    audio.currentTime = seconds
    setPosition(seconds)
    // Rejects if the system won't play this format; the timeline still says
    // where the calls are.
    audio.play()?.catch(() => setPlayable(false))
  }

  function seekFromTimeline(event: MouseEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width <= 0) return
    playFrom(((event.clientX - box.left) / box.width) * duration)
  }

  return (
    <div className="result-layout">
      <section className={`result-banner ${found ? 'result-found' : 'result-clear'}`}>
        <div className="result-icon">
          {found ? <AudioLines size={22} /> : <FileText size={22} />}
        </div>
        <div>
          <p className="eyebrow">Check complete</p>
          <h1>{found ? `${pluralizeCalls(episodes.length)} heard` : 'No loon calls heard'}</h1>
          <p>
            {found
              ? `A loon was heard in ${heard} of ${result.windows.length} three-second stretches.`
              : "We didn't hear a loon in this recording."}
          </p>
        </div>
      </section>

      <section className="result-main-grid">
        <div className="call-column">
          {audioUrl && playable && (
            <audio
              ref={audioRef}
              className="audio-player"
              src={audioUrl}
              controls
              preload="metadata"
              onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
              onError={() => setPlayable(false)}
            />
          )}
          {/* Mouse convenience; the list of calls is the accessible way in. */}
          <div
            className="call-timeline"
            onClick={seekFromTimeline}
            aria-hidden="true"
            title={playable && audioUrl ? 'Listen from here' : undefined}
          >
            {result.windows.map((w) => (
              <span
                key={w.start}
                className={w.confidence >= result.threshold ? 'call-bar heard' : 'call-bar'}
                style={{
                  left: percent(w.start),
                  width: percent(w.end - w.start),
                  height: `${Math.max(6, w.confidence * 100)}%`,
                }}
              />
            ))}
            {audioUrl && playable && (
              <span className="call-playhead" style={{ left: percent(position) }} />
            )}
          </div>
          <div className="call-axis">
            <span>0:00</span>
            <span>{formatClock(duration)}</span>
          </div>
          <p className="image-caption">
            {playable && audioUrl
              ? 'Each bar is three seconds; the taller, the surer. Click anywhere to listen from there.'
              : "This recording can't be played here, but every part of it was checked."}
          </p>
        </div>

        <div className="details-column">
          {found ? (
            <>
              <div className="detail-heading">
                <span className="status-dot" /> Call details
              </div>
              <div className="confidence-card">
                <div className="confidence-top">
                  <span>Strongest call</span>
                  <strong>{toPercent(strongest)}%</strong>
                </div>
                <div className="confidence-track">
                  <span style={{ width: `${strongest * 100}%` }} />
                </div>
                <p>Confidence indicates how strongly the model matched the sound to a loon.</p>
              </div>
              <ol className="call-list">
                {episodes.map((episode, index) => (
                  <li key={episode.start}>
                    <button
                      className="call-row"
                      onClick={() => playFrom(episode.start)}
                      disabled={!audioUrl || !playable}
                      aria-label={`Play call ${index + 1}, ${formatClock(episode.start)} to ${formatClock(episode.end)}, ${toPercent(episode.peak)}%`}
                    >
                      <span>
                        <b>{index + 1}</b>
                        <Play size={12} /> {formatClock(episode.start)} – {formatClock(episode.end)}
                      </span>
                      <strong>{toPercent(episode.peak)}%</strong>
                    </button>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <div className="clear-note">
              <p>This result is generated by an AI model and may not always be correct.</p>
              <button className="button button-dark" onClick={onCheckAnother}>
                <RotateCcw size={17} /> Try another recording
              </button>
            </div>
          )}

          <details className="details-disclosure">
            <summary>View details</summary>
            <dl>
              <div>
                <dt>Calls heard</dt>
                <dd>{episodes.length}</dd>
              </div>
              <div>
                <dt>Stretches with a call</dt>
                <dd>
                  {heard} of {result.windows.length}
                </dd>
              </div>
              <div>
                <dt>Recording length</dt>
                <dd>{formatClock(result.duration)}</dd>
              </div>
              <div>
                <dt>Audio</dt>
                <dd>
                  {(result.sampleRate / 1000).toFixed(1)} kHz,{' '}
                  {result.channels === 1 ? 'mono' : `${result.channels} channels`}
                </dd>
              </div>
              <div>
                <dt>File name</dt>
                <dd>{result.fileName}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{result.modelName}</dd>
              </div>
              <div>
                <dt>Date analyzed</dt>
                <dd>{new Date(result.timestamp).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Processing time</dt>
                <dd>{result.processingTime.toFixed(1)} seconds</dd>
              </div>
            </dl>
          </details>
        </div>
      </section>

      <section className="result-actions">
        <button className="button button-dark" onClick={onCheckAnother}>
          <RotateCcw size={17} /> Check another recording
        </button>
        <button className="button button-quiet" onClick={() => downloadCsv(result)}>
          <Download size={17} /> Download CSV
        </button>
      </section>
    </div>
  )
}
