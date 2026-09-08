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
      colors: {
        ink: '#163033',
        pine: '#1f5b55',
        water: '#dcefeb',
        reed: '#d9e5dc',
        shell: '#f7f8f3',
        sun: '#e7ad51',
      },
      fontFamily: {
        sans: ['"DM Sans"', 'sans-serif'],
        display: ['"Fraunces"', 'serif'],
      },
    },
  },
  plugins: [],
}
