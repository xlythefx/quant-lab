/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0a0a14",
          deep: "#07070f",
          panel: "#13141f",
          elev: "#1a1b28",
        },
        line: "#1f2030",
        accent: {
          blue: "#3b82f6",
          violet: "#8b5cf6",
          cyan: "#22d3ee",
        },
        profit: "#3b82f6",
        loss: "#ef4444",
        muted: "#6b7280",
        text: "#e5e7eb",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      backgroundImage: {
        "accent-grad": "linear-gradient(90deg,#3b82f6,#8b5cf6)",
      },
    },
  },
  plugins: [],
};
