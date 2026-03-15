/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,jsx}', './components/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        saf: {
          red: '#C8102E',
          navy: '#003A70',
          airforce: '#4A90E2',
          army: '#4F5B3A',
          dark: '#1F1F1F',
          mid: '#6B6B6B',
          light: '#F3F3F3',
          white: '#FFFFFF',
          high: '#D4580A',
          medium: '#B8860B',
        },
        // Operational severity (mapped to SAF palette)
        spectre: {
          dark: '#1F1F1F',
          panel: '#FFFFFF',
          border: '#E5E7EB',
          accent: '#003A70',
          critical: '#C8102E',
          high: '#D4580A',
          medium: '#B8860B',
          low: '#4F5B3A',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
