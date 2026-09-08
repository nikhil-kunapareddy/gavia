import { ShieldCheck } from 'lucide-react'

const STEPS = [
  'Upload or take a photo.',
  'The system analyzes the image.',
  'If a loon is detected, we highlight it.',
  'Review the result with your own expertise.',
]

export function AboutPage() {
  return (
    <section className="about-page">
      <div className="about-hero">
        <p className="eyebrow">A tool for the field</p>
        <h1>
          Built to support
          <br />
          <em>loon research.</em>
        </h1>
        <p className="intro-lede">
          This tool uses computer vision to help identify loons in photographs. It is designed to
          support researchers and conservation teams working with loon populations and habitat.
        </p>
      </div>

      <div className="about-content">
        <div>
          <p className="eyebrow">The simple version</p>
          <h2>How it works</h2>
        </div>
        <ol className="steps">
          {STEPS.map((step, index) => (
            <li key={step}>
              <b>{String(index + 1).padStart(2, '0')}</b>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="important-note">
        <ShieldCheck size={22} />
        <div>
          <strong>Important note</strong>
          <p>
            This tool is designed to assist researchers, not replace expert judgment. AI-generated
            results can contain errors and should be reviewed when accuracy is important.
          </p>
        </div>
      </div>
    </section>
  )
}
