// Cartao de aniversario (estilo "festa escura"): foto(s) com anel dourado,
// confete, "Parabéns, Fulano" e a data. Desenha um SVG e converte pra PNG com
// o resvg — mesmo esquema do cartao de previsao (weatherCard.js).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Resvg } from '@resvg/resvg-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_FILES = ['Medium', 'SemiBold', 'Bold', 'ExtraBold'].map((w) => path.join(__dirname, '..', 'assets', 'fonts', `Inter-${w}.otf`));

const W = 1080;
const H = 1350;
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const CONFETTI_COLORS = ['#ff5d8f', '#ffb300', '#2f8bff', '#8f6bff', '#34c759', '#ff7a00'];

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, txt, size, weight, fill) =>
  `<text x="${x}" y="${y}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="middle">${esc(txt)}</text>`;

// Pseudo-aleatorio deterministico: o confete sai igual pro mesmo cartao.
function rng(seed) {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function confetti(seed) {
  const r = rng(seed);
  let out = '';
  for (let i = 0; i < 120; i++) {
    const x = r() * W;
    const y = r() * H;
    // Longe do miolo (foto + textos) pra nao poluir a leitura.
    if ((x > 220 && x < 860 && y > 190 && y < 1100) || (x > 100 && x < 980 && y > 700 && y < 1100) || (y < 190 && x > 230 && x < 850) || (y > 1220 && x > 400 && x < 680)) continue;
    const c = CONFETTI_COLORS[Math.floor(r() * CONFETTI_COLORS.length)];
    const rot = Math.floor(r() * 360);
    const s = 10 + r() * 16;
    const kind = r();
    out += kind < 0.4
      ? `<rect x="${x}" y="${y}" width="${s}" height="${s * 0.45}" rx="3" fill="${c}" transform="rotate(${rot} ${x} ${y})" opacity=".9"/>`
      : kind < 0.75
        ? `<circle cx="${x}" cy="${y}" r="${s * 0.4}" fill="${c}" opacity=".85"/>`
        : `<path d="M${x} ${y} l${s * 0.5} ${s} l${-s} 0 z" fill="${c}" transform="rotate(${rot} ${x} ${y})" opacity=".85"/>`;
  }
  return out;
}

function cake(x, y, s) {
  return `<g transform="translate(${x},${y}) scale(${s})">
    <rect x="-70" y="10" width="140" height="56" rx="14" fill="#ffd166"/>
    <rect x="-56" y="-26" width="112" height="46" rx="12" fill="#ffffff"/>
    <path d="M-56 -4 q14 22 28 0 q14 22 28 0 q14 22 28 0 q14 22 28 0 v-8 h-112z" fill="#ff7eb6" opacity=".9"/>
    <rect x="-5" y="-62" width="10" height="38" rx="4" fill="#4f9cff"/>
    <path d="M0 -92 c14 12 14 26 0 30 c-14 -4 -14 -18 0 -30z" fill="#ffb300"/>
  </g>`;
}

// Foto redonda com anel dourado; sem foto, circulo azul/roxo com a inicial.
function person(cx, cy, r, p, i) {
  const ring = `<circle cx="${cx}" cy="${cy}" r="${r + 16}" fill="#f5b942"/><circle cx="${cx}" cy="${cy}" r="${r + 6}" fill="#fff"/>`;
  if (p.photoUri) {
    return `<defs><clipPath id="p${i}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs>${ring}` +
      `<image href="${p.photoUri}" x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" clip-path="url(#p${i})"/>`;
  }
  const initial = (p.name.trim()[0] || '?').toUpperCase();
  return `<defs><linearGradient id="f${i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2F8BFF"/><stop offset="1" stop-color="#8F6BFF"/></linearGradient></defs>${ring}` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#f${i})"/>` +
    `<text x="${cx}" y="${cy + r * 0.34}" font-family="Inter" font-size="${r * 1.0}" font-weight="800" fill="#fff" text-anchor="middle">${esc(initial)}</text>`;
}

// "A", "A e B", "A, B e C"
function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

/**
 * Gera o cartao (PNG, Buffer). people = [{ name, photoUri? }] (photoUri e um
 * data URI da foto, ou ausente pra usar a inicial); day/month = a data.
 */
export function renderBirthdayCard(people, day, month) {
  if (!people || people.length === 0) throw new Error('sem aniversariantes pra desenhar');
  const n = people.length;
  const r = n === 1 ? 190 : n === 2 ? 140 : 100;
  const cy = n === 1 ? 520 : n === 2 ? 540 : 560;
  const spacing = n === 2 ? 340 : 250; // distancia entre os centros
  const photos = people.map((p, i) => person(n === 1 ? 540 : 540 + (i - (n - 1) / 2) * spacing, cy, r, p, i)).join('');

  const names = joinNames(people.map((p) => p.name));
  // Reduz a fonte conforme o tamanho do texto, pra nunca estourar a largura.
  const nameSize = Math.max(48, Math.min(n === 1 ? 110 : 84, Math.floor(940 / (names.length * 0.6))));
  const date = `${String(day).padStart(2, '0')} de ${MONTHS[month - 1]}`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a1446"/><stop offset=".6" stop-color="#34185f"/><stop offset="1" stop-color="#4a1c55"/></linearGradient>
    <radialGradient id="glow" cx=".5" cy=".4" r=".6"><stop offset="0" stop-color="#ffcc66" stop-opacity=".35"/><stop offset="1" stop-color="#ffcc66" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#glow)"/>
  ${confetti(day * 100 + month)}
  ${text(540, 130, 'HOJE É ANIVERSÁRIO DE', 36, 700, '#f5b942')}
  ${photos}
  ${text(540, cy + r + 150, 'Parabéns,', 64, 600, 'rgba(255,255,255,.85)')}
  ${text(540, cy + r + 150 + nameSize * 0.95 + 20, names, nameSize, 800, '#ffffff')}
  ${text(540, cy + r + 150 + nameSize * 0.95 + 90, date, 40, 600, '#f5b942')}
  ${cake(540, H - 190, 0.9)}
  ${text(540, H - 70, 'Bothierry', 28, 700, 'rgba(255,255,255,.55)')}
</svg>`;

  return new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();
}

/** Redimensiona a foto (Buffer) pra um quadrado e devolve como data URI PNG. */
export async function photoToDataUri(buffer, size = 420) {
  const sharp = (await import('sharp')).default;
  const png = await sharp(buffer).resize(size, size, { fit: 'cover', kernel: 'lanczos3' }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}
