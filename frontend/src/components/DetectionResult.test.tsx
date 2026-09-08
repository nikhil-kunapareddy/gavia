import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Detection, DetectionResult as Result } from '../types/detection'
import { DetectionResult } from './DetectionResult'

function detection(id: string, confidence: number): Detection {
  return { id, label: 'Loon', confidence, boundingBox: { x: 10, y: 10, width: 20, height: 20 } }
}

function makeResult(detections: Detection[]): Result {
  return {
    id: 'result-1',
    imageUrl: 'data:image/png;base64,abc',
    fileName: 'photo.jpg',
    fileSize: 1000,
    detections,
    processingTime: 1.1,
    timestamp: '2026-09-06T10:00:00.000Z',
  }
}

function renderResult(detections: Detection[]) {
  return render(
    <DetectionResult
      result={makeResult(detections)}
      onCheckAnother={vi.fn()}
      onSave={vi.fn()}
      saved={false}
    />,
  )
}

describe('DetectionResult', () => {
  it('shows the true maximum confidence when detections are unsorted', () => {
    const { container } = renderResult([
      detection('a', 0.62),
      detection('b', 0.97),
      detection('c', 0.81),
    ])

    // Scoped to the summary card: 97% also appears in its own detection row.
    const card = container.querySelector('.confidence-card')
    expect(card).not.toBeNull()
    // Reading detections[0] would have shown 62% here.
    expect(within(card as HTMLElement).getByText('97%')).toBeInTheDocument()
  })

  it('reports a singular loon for one detection', () => {
    renderResult([detection('a', 0.94)])
    expect(screen.getByRole('heading', { name: '1 loon detected' })).toBeInTheDocument()
  })

  it('reports plural loons for several detections', () => {
    renderResult([detection('a', 0.94), detection('b', 0.9)])
    expect(screen.getByRole('heading', { name: '2 loons detected' })).toBeInTheDocument()
  })

  it('renders the empty state when nothing was detected', () => {
    renderResult([])
    expect(screen.getByRole('heading', { name: 'No loon detected' })).toBeInTheDocument()
    expect(screen.queryByText('Highest confidence')).not.toBeInTheDocument()
  })

  it('renders one row per detection, in order', () => {
    const { container } = renderResult([
      detection('a', 0.9),
      detection('b', 0.8),
      detection('c', 0.7),
    ])

    const rows = Array.from(container.querySelectorAll('.detection-row'))
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual([
      '90%',
      '80%',
      '70%',
    ])
  })

  it('disables the save button once saved', () => {
    render(
      <DetectionResult
        result={makeResult([detection('a', 0.9)])}
        onCheckAnother={vi.fn()}
        onSave={vi.fn()}
        saved
      />,
    )
    expect(screen.getByRole('button', { name: /Saved to history/ })).toBeDisabled()
  })
})
