// Cartao da meia-noite da estreia do GTA VI (19/11/2026): ceu noturno, "VI"
// neon, sol de Vice City, palmeiras e chao em grade. SVG -> PNG com o resvg,
// mesmo esquema dos outros cartoes.
import path from 'path';
import { fileURLToPath } from 'url';
import { Resvg } from '@resvg/resvg-js';
import { palm } from './weatherCard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_FILES = ['Medium', 'Bold', 'ExtraBold'].map((w) => path.join(__dirname, '..', 'assets', 'fonts', `Inter-${w}.otf`));
const BOT_PHOTO_PATH = path.join(__dirname, '..', 'assets', 'bot-photo.png');
const W = 1080;
const H = 1350;

const text = (x, y, t, size, weight, fill, extra = '') =>
  `<text x="${x}" y="${y}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="middle" ${extra}>${t}</text>`;

async function botPhotoDataUri() {
  try {
    const sharp = (await import('sharp')).default;
    const buffer = await sharp(BOT_PHOTO_PATH).resize(240, 240).png().toBuffer();
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

/** Gera o cartao da estreia (PNG, Buffer). */
export async function renderPremiereCard() {
  const photo = await botPhotoDataUri();
  let grid = '';
  for (let i = 0; i <= 12; i++) grid += `<line x1="540" y1="1000" x2="${540 + (i - 6) * 260}" y2="${H}" stroke="#ff5da2" stroke-width="2" opacity=".7"/>`;
  for (let i = 0; i < 7; i++) {
    const y = 1010 + Math.pow(i / 6, 1.8) * 340;
    grid += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#ff5da2" stroke-width="2" opacity=".7"/>`;
  }
  const stars = Array.from({ length: 60 }, (_, i) => `<circle cx="${(i * 197) % W}" cy="${(i * 89) % 520}" r="${1 + (i % 3)}" fill="#fff" opacity="${0.25 + (i % 5) * 0.12}"/>`).join('');
  const stripes = [0, 1, 2, 3, 4, 5].map((i) => `<rect x="190" y="${860 + i * 24}" width="700" height="${5 + i * 3}" fill="#4a1470" opacity=".9"/>`).join('');
  const avatar = photo
    ? `<circle cx="540" cy="190" r="100" fill="#f5b942"/><circle cx="540" cy="190" r="90" fill="#fff"/><image href="${photo}" x="454" y="104" width="172" height="172" clip-path="url(#c)"/>`
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d0420"/><stop offset=".5" stop-color="#4a1470"/><stop offset=".72" stop-color="#ff3d8b"/><stop offset="1" stop-color="#ff9a3d"/></linearGradient>
    <linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe66d"/><stop offset="1" stop-color="#ff4f8b"/></linearGradient>
    <linearGradient id="vi" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff5da2"/><stop offset="1" stop-color="#ffb347"/></linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="16"/></filter>
    <clipPath id="c"><circle cx="540" cy="190" r="86"/></clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  ${stars}
  <circle cx="540" cy="1000" r="300" fill="url(#sun)"/>
  ${stripes}
  <rect x="0" y="1000" width="${W}" height="${H - 1000}" fill="#12061f"/>
  ${grid}
  ${palm(110, 1060, 1.0, false, '#12061f')}${palm(970, 1060, 1.0, true, '#12061f')}
  ${avatar}
  ${text(540, 345, 'ÀS 00:00 DE 19 DE NOVEMBRO', 34, 700, '#ffd0e4')}
  ${text(540, 650, 'VI', 360, 800, '#ff5da2', 'filter="url(#glow)" opacity=".9"')}
  ${text(540, 650, 'VI', 360, 800, 'url(#vi)')}
  <rect x="90" y="715" width="900" height="170" rx="40" fill="#12061f" fill-opacity=".78"/>
  ${text(540, 797, 'BEM-VINDOS A VICE CITY', 62, 800, '#ffffff')}
  ${text(540, 852, 'O jogo chegou. Boa jogatina, grupo!', 34, 600, '#ffc2dd')}
  ${text(540, 1290, 'Bothierry', 26, 700, 'rgba(255,255,255,.7)')}
</svg>`;

  return new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();
}
