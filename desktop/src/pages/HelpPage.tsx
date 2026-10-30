const STEPS = [
  'Upload a photo, several, or a zip of up to 25.',
  'The system analyzes the image.',
  'If a loon is detected, we highlight it.',
  'Review the result with your own expertise.',
]

const CALL_STEPS = [
  'Upload a recording: WAV, MP3, FLAC, OGG, M4A, or a video with sound.',
  'Every three seconds of it is checked for a loon call.',
  'Calls are marked on a timeline; click one to hear it.',
  'Listen for yourself before relying on it.',
]

function Steps({ steps }: { steps: string[] }) {
  return (
    <ol className="steps">
      {steps.map((step, index) => (
        <li key={step}>
          <b>{String(index + 1).padStart(2, '0')}</b>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  )
}

export function HelpPage() {
  return (
    <section className="about-page">
      <div className="about-hero">
        <h1>
          Built to support
          <br />
          <em>loon research.</em>
        </h1>
        <p className="intro-lede">
          This tool uses computer vision to help identify loons in photographs, and listens for
          their calls in recordings. It is designed to support researchers and conservation teams
          working with loon populations and habitat.
        </p>
      </div>

      <div className="about-content">
        <div>
          <h2>How it works</h2>
        </div>
        <Steps steps={STEPS} />
      </div>

      <div className="about-content">
        <div>
          <h2>Listening for calls</h2>
        </div>
        <Steps steps={CALL_STEPS} />
      </div>
    </section>
  )
}
