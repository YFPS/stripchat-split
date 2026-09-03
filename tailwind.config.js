/** @type {import('tailwindcss').Config} */
// GSAP 设计语言：近黑画布 + 奶油色文字 + 幽灵描边按钮 + 分类颜色标签
// 替代原先 Stripchat 原生配色（粉色品牌 #ff1f8c、深灰卡片 #1e1e1e）
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // ── GSAP 基础色 ──
        'just-black': '#0e100f',
        'off-black': '#191919',
        'surface-cream': '#fffce1',
        'surface-50': '#7c7c6f',
        'surface-25': '#42433d',
        // ── GSAP 分类强调色 ──
        'shockingly-green': '#0ae448',
        'light-green': '#abff84',
        'orangey': '#ff8709',
        'pink': '#fec5fb',
        'lilac': '#9d95ff',
        'blue': '#00bae2',
        'core-green': '#dfffd1',
        'lipstick-pink': '#f100cb',
      },
      fontFamily: {
        // Mori 替代：Inter Tight（humanist warmth，最接近 Mori 的免费字体）
        'mori': ['"Inter Tight"', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
      },
      backgroundImage: {
        // CTA 渐变描边（GSAP 品牌绿）
        'gsap-green-gradient': 'linear-gradient(114.41deg, #0ae448 20.74%, #abff84 65.5%)',
      },
      borderRadius: {
        'card': '8px',
        'pill': '9999px',
        'button': '100px',
        'tag': '8px',
      },
      spacing: {
        '18': '4.5rem',   // 72px
        '19': '4.75rem',  // 76px
        '24': '6rem',     // 96px
        '27': '6.75rem',  // 108px
      },
    },
  },
  plugins: [],
}
