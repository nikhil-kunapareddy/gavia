import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Detection } from '../types/detection'
import { DetectionOverlay } from './DetectionOverlay'

function detection(id: string, box: Detection['boundingBox'], confidence = 0.9): Detection {
  return { id, label: 'Loon', confidence, boundingBox: box }
}

function boxes(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.detection-box'))
}

describe('DetectionOverlay', () => {
  it('positions a box using percentages, so it scales with the image', () => {
    // Percentages are the whole reason the overlay works at any display size;
    // a pixel value here would misplace every box on a resized image.
    render(
      <DetectionOverlay
        imageUrl="blob:x"
        alt="A loon"
        detections={[detection('a', { x: 35, y: 24, width: 29, height: 45 })]}
      />,
    )

    const [box] = boxes()
    expect(box.style.left).toBe('35%')
    expect(box.style.top).toBe('24%')
    expect(box.style.width).toBe('29%')
    expect(box.style.height).toBe('45%')
  })

  it('draws one box per detection', () => {
    render(
      <DetectionOverlay
        imageUrl="blob:x"
        alt="Loons"
        detections={[
          detection('a', { x: 10, y: 10, width: 10, height: 10 }),
          detection('b', { x: 40, y: 40, width: 10, height: 10 }),
          detection('c', { x: 70, y: 70, width: 10, height: 10 }),
        ]}
      />,
    )

    expect(boxes()).toHaveLength(3)
  })

  it('numbers the boxes and shows confidence as a whole percentage', () => {
    render(
      <DetectionOverlay
        imageUrl="blob:x"
        alt="Loons"
        detections={[
          detection('a', { x: 10, y: 10, width: 10, height: 10 }, 0.937),
          detection('b', { x: 40, y: 40, width: 10, height: 10 }, 0.8),
        ]}
      />,
    )

    expect(screen.getByText('1 · 94%')).toBeInTheDocument()
    expect(screen.getByText('2 · 80%')).toBeInTheDocument()
  })

  it('renders the image with the alt text it was given', () => {
    render(<DetectionOverlay imageUrl="/api/results/x/image" alt="Saved check" detections={[]} />)

    const image = screen.getByAltText('Saved check')
    expect(image).toHaveAttribute('src', '/api/results/x/image')
  })

  it('shows the image with no boxes when nothing was detected', () => {
    render(<DetectionOverlay imageUrl="blob:x" alt="Clear water" detections={[]} />)

    expect(screen.getByAltText('Clear water')).toBeInTheDocument()
    expect(boxes()).toHaveLength(0)
  })

  it('handles a box that runs to the edge of the frame', () => {
    render(
      <DetectionOverlay
        imageUrl="blob:x"
        alt="Edge"
        detections={[detection('a', { x: 0, y: 0, width: 100, height: 100 })]}
      />,
    )

    const [box] = boxes()
    expect(box.style.left).toBe('0%')
    expect(box.style.width).toBe('100%')
  })
})
