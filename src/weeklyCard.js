// Cartao do resumo semanal (estilo "festa escura", igual ao de aniversario):
// campeao com foto e anel dourado, top 5 com barras e blocos de numeros.
// Desenha um SVG e converte pra PNG com o resvg (mesmo esquema do birthdayCard).
import path from 'path';
import { fileURLToPath } from 'url';
import { Resvg } from '@resvg/resvg-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_FILES = ['Medium', 'SemiBold', 'Bold', 'ExtraBold'].map((w) => path.join(__dirname, '..', 'assets', 'fonts', `Inter-${w}.otf`));

const W = 1080;
const H = 1720;
const CONFETTI_COLORS = ['#ff5d8f', '#ffb300', '#2f8bff', '#8f6bff', '#34c759', '#ff7a00'];
const RANK_COLORS = ['#ffb300', '#c7cdd6', '#d98a4e', '#6f7bf7', '#6f7bf7'];

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, txt, size, weight, fill, anchor = 'start') =>
  `<text x="${x}" y="${y}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(txt)}</text>`;

// Reduz a fonte conforme o tamanho do texto, pra nao estourar a largura.
const fit = (txt, maxWidth, maxSize, minSize = 26) => Math.max(minSize, Math.min(maxSize, Math.floor(maxWidth / (String(txt).length * 0.58))));

function confetti() {
  let s = 7;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let out = '';
  for (let i = 0; i < 90; i++) {
    const x = r() * W;
    const y = r() * H;
    const c = CONFETTI_COLORS[Math.floor(r() * CONFETTI_COLORS.length)];
    const size = 4 + r() * 7;
    if (y > 200 && y < 1660 && x > 40 && x < 1040) continue;
    out += `<circle cx="${x}" cy="${y}" r="${size}" fill="${c}" opacity=".8"/>`;
  }
  return out;
}

const tile = (x, y, w, label, value, sub) =>
  `<rect x="${x}" y="${y}" width="${w}" height="190" rx="32" fill="#ffffff" fill-opacity=".09"/>` +
  text(x + 34, y + 52, label, 24, 700, '#f5b942') +
  text(x + 34, y + 122, value, fit(value, w - 68, 56, 34), 800, '#fff') +
  text(x + 34, y + 162, sub, fit(sub, w - 68, 24, 18), 600, 'rgba(255,255,255,.65)');

/**
 * Gera o cartao (PNG, Buffer). data = {
 *   rangeLabel, total, deltaLabel, peakHour, peakDayName, linkMessages,
 *   topLinkRepeats, audio: { name, count } | null,
 *   ranking: [{ name, total }] (ja ordenado; so os 5 primeiros sao desenhados),
 *   championPhotoUri?: data URI da foto do campeao (sem foto, usa a inicial)
 * }
 */
export function renderWeeklyCard(data) {
  const top = data.ranking.slice(0, 5);
  const champ = top[0];
  const max = champ.total;
  const percent = data.total > 0 ? Math.round((champ.total / data.total) * 100) : 0;

  const initial = (champ.name.trim()[0] || '?').toUpperCase();
  const avatar = data.championPhotoUri
    ? `<defs><clipPath id="cp"><circle cx="230" cy="375" r="96"/></clipPath></defs><circle cx="230" cy="375" r="112" fill="#f5b942"/><circle cx="230" cy="375" r="102" fill="#fff"/>` +
      `<image href="${data.championPhotoUri}" x="134" y="279" width="192" height="192" clip-path="url(#cp)"/>`
    : `<circle cx="230" cy="375" r="112" fill="#f5b942"/><circle cx="230" cy="375" r="102" fill="#fff"/><circle cx="230" cy="375" r="96" fill="url(#av)"/>` +
      text(230, 410, initial, 104, 800, '#fff', 'middle');

  let rank = '';
  top.forEach((p, i) => {
    const y = 700 + i * 104;
    const bar = Math.max(18, Math.round((600 * p.total) / max));
    rank +=
      `<circle cx="112" cy="${y}" r="34" fill="${RANK_COLORS[i]}"/>` + text(112, y + 12, String(i + 1), 34, 800, '#1a1446', 'middle') +
      text(170, y - 6, p.name, fit(p.name, 600, 34, 24), 700, '#fff') +
      `<rect x="170" y="${y + 8}" width="600" height="18" rx="9" fill="#ffffff" fill-opacity=".12"/>` +
      `<rect x="170" y="${y + 8}" width="${bar}" height="18" rx="9" fill="${i === 0 ? '#f5b942' : '#8f6bff'}"/>` +
      text(1000, y + 22, String(p.total), 38, 800, i === 0 ? '#f5b942' : '#fff', 'end');
  });

  const nf = new Intl.NumberFormat('pt-BR');
  const linkSub = data.topLinkRepeats >= 2 ? `mais repetido: ${data.topLinkRepeats}x` : 'nenhum repetido';
  const audioValue = data.audio ? `!${data.audio.name}` : '—';
  const audioSub = data.audio ? `usado ${data.audio.count} ${data.audio.count === 1 ? 'vez' : 'vezes'}` : 'nenhum usado';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a1446"/><stop offset=".6" stop-color="#34185f"/><stop offset="1" stop-color="#4a1c55"/></linearGradient>
    <radialGradient id="glow" cx=".5" cy=".12" r=".6"><stop offset="0" stop-color="#ffcc66" stop-opacity=".3"/><stop offset="1" stop-color="#ffcc66" stop-opacity="0"/></radialGradient>
    <linearGradient id="av" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2F8BFF"/><stop offset="1" stop-color="#8F6BFF"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#glow)"/>
  ${confetti()}
  ${text(540, 110, 'RESUMO DA SEMANA', 30, 700, '#f5b942', 'middle')}
  ${text(540, 160, data.rangeLabel, 26, 600, 'rgba(255,255,255,.7)', 'middle')}
  <rect x="60" y="210" width="960" height="330" rx="44" fill="#ffffff" fill-opacity=".09"/>
  ${avatar}
  ${text(400, 300, 'CAMPEÃO DA SEMANA', 26, 700, '#f5b942')}
  ${text(400, 372, champ.name, fit(champ.name, 590, 68, 36), 800, '#fff')}
  ${text(400, 430, `${nf.format(champ.total)} ${champ.total === 1 ? 'mensagem' : 'mensagens'}`, 36, 600, 'rgba(255,255,255,.85)')}
  ${text(400, 480, `${percent}% de tudo que o grupo falou`, 26, 600, 'rgba(255,255,255,.6)')}
  ${text(60, 620, 'TOP 5', 30, 800, '#fff')}
  ${rank}
  ${tile(60, 1250, 462, 'MENSAGENS', nf.format(data.total), data.deltaLabel)}
  ${tile(558, 1250, 462, 'HORÁRIO DE PICO', `${data.peakHour}h`, `dia mais cheio: ${data.peakDayName}`)}
  ${tile(60, 1470, 462, 'LINKS', nf.format(data.linkMessages), linkSub)}
  ${tile(558, 1470, 462, 'ÁUDIO DA SEMANA', audioValue, audioSub)}
  ${text(540, 1675, 'Bothierry', 26, 700, 'rgba(255,255,255,.5)', 'middle')}
</svg>`;

  return new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();
}
