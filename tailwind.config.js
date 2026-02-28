/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './App.tsx',
    './index.tsx',
    './components/**/*.{ts,tsx}',
    './context/**/*.{ts,tsx}',
    './pages/**/*.{ts,tsx}',
    './services/**/*.{ts,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f2f5f9',
          100: '#e1e9f1',
          200: '#c8d6e6',
          300: '#a1bbd4',
          400: '#7399bf',
          500: '#527aad',
          600: '#406191',
          700: '#344e76',
          800: '#3e5275',
          900: '#212e4a',
          950: '#162036',
        },
        gold: {
          50: '#fdf9ed',
          100: '#f9efd1',
          200: '#f3dea4',
          300: '#ebc56d',
          400: '#f0b84f',
          500: '#e3992e',
          600: '#d4a017',
          700: '#a37115',
          800: '#855b17',
          900: '#714d18',
        }
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' }
        }
      },
      animation: {
        'fade-in': 'fadeIn 200ms ease-out forwards'
      }
    }
  },
  plugins: []
};
