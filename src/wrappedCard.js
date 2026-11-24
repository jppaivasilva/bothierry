// Cartoes do Bothierry Wrapped (estilo escuro, igual aos de aniversario e
// resumo semanal): um por pessoa (1080x1350) e um do grupo (1080x1750).
import path from 'path';
import { fileURLToPath } from 'url';
import { Resvg } from '@resvg/resvg-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_FILES = ['Medium', 'SemiBold', 'Bold', 'ExtraBold'].map((w) => path.join(__dirname, '..', 'assets', 'fonts', `Inter-${w}.otf`));
const W = 1080;
const COLORS = ['#ff5d8f', '#ffb300', '#2f8bff', '#8f6bff', '#34c759', '#ff7a00'];
const RANK_COLORS = ['#ffb300', '#c7cdd6', '#d98a4e', '#6f7bf7', '#6f7bf7'];
const MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, txt, size, weight, fill, anchor = 'start') =>
  `<text x="${x}" y="${y}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(txt)}</text>`;
const fit = (txt, maxWidth, maxSize, minSize = 24) => Math.max(minSize, Math.min(maxSize, Math.floor(maxWidth / (String(txt).length * 0.58))));
const nf = new Intl.NumberFormat('pt-BR');
const fmtDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

function confetti(height, seed = 7) {
  let s = seed;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let out = '';
  for (let i = 0; i < 90; i++) {
    const x = r() * W;
    const y = r() * height;
    const c = COLORS[Math.floor(r() * COLORS.length)];
    const size = 4 + r() * 7;
    if ((y > 200 && y < height - 90 && x > 40 && x < 1040) || (y < 200 && x > 180 && x < 900) || (y > height - 90 && x > 400 && x < 680)) continue;
    out += `<circle cx="${x}" cy="${y}" r="${size}" fill="${c}" opacity=".8"/>`;
  }
  return out;
}

const tile = (x, y, w, label, value, sub = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="190" rx="32" fill="#ffffff" fill-opacity=".09"/>` +
  text(x + 32, y + 50, label, 22, 700, '#f5b942') +
  text(x + 32, y + 118, value, fit(value, w - 64, 54, 30), 800, '#fff') +
  (sub ? text(x + 32, y + 160, sub, fit(sub, w - 64, 24, 16), 600, 'rgba(255,255,255,.65)') : '');

function frame(height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a1446"/><stop offset=".6" stop-color="#34185f"/><stop offset="1" stop-color="#4a1c55"/></linearGradient>
    <radialGradient id="glow" cx=".5" cy=".18" r=".6"><stop offset="0" stop-color="#ffcc66" stop-opacity=".3"/><stop offset="1" stop-color="#ffcc66" stop-opacity="0"/></radialGradient>
    <linearGradient id="av" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2F8BFF"/><stop offset="1" stop-color="#8F6BFF"/></linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffd166"/><stop offset="1" stop-color="#ff8fb8"/></linearGradient>
  </defs>
  <rect width="${W}" height="${height}" fill="url(#bg)"/><rect width="${W}" height="${height}" fill="url(#glow)"/>
  ${confetti(height)}
  ${body}
  ${text(540, height - 40, 'Bothierry', 26, 700, 'rgba(255,255,255,.5)', 'middle')}
</svg>`;
}

const render = (svg) => new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();

/** Cartao individual. stats vem de computeWrapped().people; photoUri (data URI) e opcional. */
export function renderWrappedPersonCard(stats, year, photoUri = null) {
  const initial = (stats.name.trim()[0] || '?').toUpperCase();
  const avatar = photoUri
    ? `<defs><clipPath id="cp"><circle cx="540" cy="330" r="130"/></clipPath></defs><circle cx="540" cy="330" r="150" fill="#f5b942"/><circle cx="540" cy="330" r="140" fill="#fff"/><image href="${photoUri}" x="410" y="200" width="260" height="260" clip-path="url(#cp)"/>`
    : `<circle cx="540" cy="330" r="150" fill="#f5b942"/><circle cx="540" cy="330" r="140" fill="#fff"/><circle cx="540" cy="330" r="130" fill="url(#av)"/>${text(540, 375, initial, 130, 800, '#fff', 'middle')}`;
  const words = stats.topWords.length ? stats.topWords.join('  ·  ') : '—';
  const body = `
  ${text(540, 110, `BOTHIERRY WRAPPED ${year}`, 34, 800, '#f5b942', 'middle')}
  ${avatar}
  ${text(540, 570, stats.name, fit(stats.name, 900, 84, 44), 800, '#fff', 'middle')}
  <rect x="290" y="605" width="500" height="54" rx="27" fill="url(#gold)"/>
  ${text(540, 642, `${stats.badge.title} · ${stats.badge.desc}`.length > 40 ? stats.badge.title : `${stats.badge.title} · ${stats.badge.desc}`, 26, 800, '#2b0f5e', 'middle')}
  ${text(540, 810, nf.format(stats.total), 150, 800, '#ffffff', 'middle')}
  ${text(540, 865, stats.total === 1 ? `mensagem em ${year}` : `mensagens em ${year}`, 34, 600, 'rgba(255,255,255,.85)', 'middle')}
  ${text(540, 915, `#${stats.rank} de ${stats.of} · ${stats.percent}% de tudo que o grupo falou`, 28, 700, '#f5b942', 'middle')}
  ${tile(60, 950, 462, 'HORÁRIO FAVORITO', `${stats.peakHour}h`, 'quando mais fala')}
  ${tile(558, 950, 462, 'DIA FAVORITO', stats.favoriteWeekday, 'dia da semana')}
  ${tile(60, 1160, 462, 'MAIOR SEQUÊNCIA', `${stats.streak} ${stats.streak === 1 ? 'dia' : 'dias'}`, 'falando todo dia')}
  ${tile(558, 1160, 462, 'CAMPEÃO DO DIA', `${stats.championDays}x`, `${stats.activeDays} dias ativo`)}
  ${text(540, 1385, 'PALAVRAS MAIS USADAS', 22, 700, 'rgba(255,255,255,.6)', 'middle')}
  ${text(540, 1440, words, fit(words, 940, 46, 26), 800, '#ffffff', 'middle')}`;
  return render(frame(1530, body));
}

/** Cartao do grupo. group vem de computeWrapped().group. */
export function renderWrappedGroupCard(group, since) {
  const max = group.top5[0].total;
  let rank = '';
  group.top5.forEach((p, i) => {
    const y = 770 + i * 100;
    const bar = Math.max(18, Math.round((600 * p.total) / max));
    rank +=
      `<circle cx="112" cy="${y}" r="32" fill="${RANK_COLORS[i]}"/>` + text(112, y + 11, String(i + 1), 32, 800, '#1a1446', 'middle') +
      text(170, y - 6, p.name, fit(p.name, 600, 32, 22), 700, '#fff') +
      `<rect x="170" y="${y + 8}" width="600" height="16" rx="8" fill="#ffffff" fill-opacity=".12"/>` +
      `<rect x="170" y="${y + 8}" width="${bar}" height="16" rx="8" fill="${i === 0 ? '#f5b942' : '#8f6bff'}"/>` +
      text(1000, y + 22, nf.format(p.total), 36, 800, i === 0 ? '#f5b942' : '#fff', 'end');
  });
  const words = group.topWords.length ? group.topWords.join('  ·  ') : '—';
  const body = `
  ${text(540, 120, `BOTHIERRY WRAPPED ${group.year}`, 38, 800, '#f5b942', 'middle')}
  ${text(540, 170, `o ano do grupo em números · desde ${fmtDate(since)}`, 26, 600, 'rgba(255,255,255,.7)', 'middle')}
  ${text(540, 400, nf.format(group.total), 190, 800, '#ffffff', 'middle')}
  ${text(540, 460, 'mensagens trocadas', 40, 600, 'rgba(255,255,255,.85)', 'middle')}
  ${text(540, 515, `${group.members} pessoas · ${group.activeDays} dias de conversa`, 30, 700, '#f5b942', 'middle')}
  ${group.championName ? text(540, 585, `Campeão de dias: ${group.championName} (${group.championDays}x)`, fit(group.championName, 900, 36, 22), 800, '#ffffff', 'middle') : ''}
  ${text(60, 690, 'TOP 5 DO ANO', 30, 800, '#fff')}
  ${rank}
  ${tile(60, 1290, 462, 'DIA MAIS MOVIMENTADO', fmtDate(group.busiestDate), `${nf.format(group.busiestDateCount)} mensagens`)}
  ${tile(558, 1290, 462, 'MÊS MAIS ATIVO', group.busiestMonth, 'mais conversa')}
  ${tile(60, 1500, 462, 'HORÁRIO DE PICO', `${group.peakHour}h`, 'o grupo mais fala')}
  ${tile(558, 1500, 462, 'LINKS', nf.format(group.links), 'compartilhados')}
  ${text(540, 1745, 'PALAVRAS DO ANO', 22, 700, 'rgba(255,255,255,.6)', 'middle')}
  ${text(540, 1805, words, fit(words, 960, 48, 26), 800, '#ffffff', 'middle')}
  ${text(540, 1865, 'Digite !wrapped pra ver o seu', 28, 700, '#f5b942', 'middle')}`;
  return render(frame(1960, body));
}
