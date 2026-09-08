/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  // The UI is built from the hand-written classes in index.css and never uses
  // Tailwind's .container. Left enabled, the scanner matches the bare word
  // `container` in source (e.g. Testing Library's `const { container } = ...`)
  // and emits the class plus all five breakpoint variants into the bundle.
  corePlugins: { container: false },
  theme: {
    extend: {
      // Common loon breeding plumage: a green-black head, one crimson eye, a
      // checkered back and a white breast, on cold northern lake water.
      colors: {
        ink: '#111b1e',
        iridescence: '#1d443f',
        lake: '#dbe7ee',
        slate: '#d8e0e4',
        breast: '#f6f8f9',
        eye: '#b3242c',
      },
      fontFamily: {
        sans: ['"DM Sans"', 'sans-serif'],
        display: ['"Fraunces"', 'serif'],
      },
    },
  },
  plugins: [],
}
