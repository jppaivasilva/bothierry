// Cartao da nuvem de palavras do dia (estilo escuro, igual aos de aniversario e
// resumo semanal). Mesmo layout em espiral do painel, mas feito aqui no
// servidor: a largura de cada palavra e medida desenhando-a com o resvg.
import path from 'path';
import { fileURLToPath } from 'url';
import { Resvg } from '@resvg/resvg-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_FILES = ['Medium', 'SemiBold', 'Bold', 'ExtraBold'].map((w) => path.join(__dirname, '..', 'assets', 'fonts', `Inter-${w}.otf`));
const FONT_OPTIONS = { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' };

const W = 1080;
const H = 1350;
const AREA = { x: 50, y: 250, w: 980, h: 960 }; // onde a nuvem pode ocupar
const COLORS = ['#f5b942', '#ff5d8f', '#2f8bff', '#8f6bff', '#34c759', '#ff7a00', '#ffffff'];
const CONFETTI_COLORS = ['#ff5d8f', '#ffb300', '#2f8bff', '#8f6bff', '#34c759'];

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Largura de uma palavra (px) na fonte e tamanho dados, medida pelo proprio resvg.
function measure(word, size) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${size * 2}"><text x="0" y="${size * 1.4}" font-family="Inter" font-size="${size}" font-weight="800">${esc(word)}</text></svg>`;
  const box = new Resvg(svg, { font: FONT_OPTIONS }).innerBBox();
  return box ? Math.ceil(box.width) : Math.ceil(word.length * size * 0.62);
}

function confetti() {
  let s = 11;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let out = '';
  for (let i = 0; i < 70; i++) {
    const x = r() * W;
    const y = r() * H;
    const c = CONFETTI_COLORS[Math.floor(r() * CONFETTI_COLORS.length)];
    const size = 4 + r() * 7;
    if ((x > 30 && x < 1050 && y > 230 && y < 1230) || (x > 200 && x < 880 && y < 240) || (x > 380 && x < 700 && y > 1270)) continue;
    out += `<circle cx="${x}" cy="${y}" r="${size}" fill="${c}" opacity=".8"/>`;
  }
  return out;
}

/**
 * Gera o cartao (PNG, Buffer). words = [{ word, count }] (mais frequentes primeiro);
 * date = "YYYY-MM-DD"; totalMessages = mensagens contadas no dia.
 */
export function renderWordCloudCard(words, date, totalMessages) {
  if (!words || words.length === 0) throw new Error('sem palavras pra desenhar');
  const maxCount = words[0].count;
  const minCount = words[words.length - 1].count;
  const maxSize = 150;
  const minSize = 30;
  const placed = [];
  let body = '';

  words.forEach((w, i) => {
    const ratio = maxCount === minCount ? 1 : (w.count - minCount) / (maxCount - minCount);
    let size = Math.round(minSize + Math.sqrt(ratio) * (maxSize - minSize));
    // Palavra mais larga que a area: encolhe pra caber.
    let width = measure(w.word, size);
    if (width > AREA.w - 20) {
      size = Math.floor((size * (AREA.w - 20)) / width);
      width = measure(w.word, size);
    }
    const bw = width + 14;
    const bh = Math.round(size * 1.05) + 8;
    const cx = AREA.x + AREA.w / 2;
    const cy = AREA.y + AREA.h / 2;
    let spot = null;
    for (let t = 0; t < 6000 && !spot; t += 1) {
      const angle = t * 0.3;
      const radius = 2.2 * angle;
      const x = cx + radius * Math.cos(angle) * 1.15 - bw / 2;
      const y = cy + radius * Math.sin(angle) - bh / 2;
      if (x < AREA.x || y < AREA.y || x + bw > AREA.x + AREA.w || y + bh > AREA.y + AREA.h) continue;
      if (!placed.some((p) => x < p.x + p.w && x + bw > p.x && y < p.y + p.h && y + bh > p.y)) spot = { x, y, w: bw, h: bh };
    }
    if (!spot) return;
    placed.push(spot);
    const tx = spot.x + 7;
    const ty = spot.y + 4 + size * 0.82;
    body += `<text x="${tx}" y="${ty}" font-family="Inter" font-size="${size}" font-weight="800" fill="${COLORS[i % COLORS.length]}">${esc(w.word)}</text>`;
  });

  const [yy, mm, dd] = date.split('-').map(Number);
  const dateLabel = `${String(dd).padStart(2, '0')} de ${MONTHS[mm - 1]} de ${yy}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a1446"/><stop offset=".6" stop-color="#34185f"/><stop offset="1" stop-color="#4a1c55"/></linearGradient>
    <radialGradient id="glow" cx=".5" cy=".45" r=".6"><stop offset="0" stop-color="#ffcc66" stop-opacity=".18"/><stop offset="1" stop-color="#ffcc66" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#glow)"/>
  ${confetti()}
  <text x="540" y="115" font-family="Inter" font-size="34" font-weight="700" fill="#f5b942" text-anchor="middle">NUVEM DE PALAVRAS</text>
  <text x="540" y="175" font-family="Inter" font-size="46" font-weight="800" fill="#ffffff" text-anchor="middle">${esc(dateLabel)}</text>
  <text x="540" y="218" font-family="Inter" font-size="26" font-weight="600" fill="rgba(255,255,255,.65)" text-anchor="middle">${totalMessages} mensagens no dia</text>
  ${body}
  <text x="540" y="1310" font-family="Inter" font-size="26" font-weight="700" fill="rgba(255,255,255,.5)" text-anchor="middle">Bothierry</text>
</svg>`;

  return new Resvg(svg, { font: FONT_OPTIONS }).render().asPng();
}
