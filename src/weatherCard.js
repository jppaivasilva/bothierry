// Cartao de previsao do tempo do bom dia: desenha um SVG (estilo do painel,
// versao clara em lista) e converte pra PNG com o resvg. Tudo local — sem
// servico externo alem da propria Open-Meteo (dados vem de weather.js).
//
// As fontes (assets/fonts) vao junto com o projeto porque a VM nao tem fontes
// instaladas; os icones sao desenhados em vetor aqui mesmo (nada de emoji).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Resvg } from '@resvg/resvg-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_FILES = ['Medium', 'SemiBold', 'Bold', 'ExtraBold'].map((w) => path.join(__dirname, '..', 'assets', 'fonts', `Inter-${w}.otf`));
const BOT_PHOTO_PATH = path.join(__dirname, '..', 'assets', 'bot-photo.png');
const TIMEZONE = 'America/Sao_Paulo';

const WIDTH = 1080;
const ROW_HEIGHT = 170;

// ---------- icones vetoriais (centro em 0,0) ----------
function cloudShape(fill) {
  return `<g fill="${fill}"><circle cx="-22" cy="8" r="22"/><circle cx="4" cy="-8" r="30"/><circle cx="34" cy="8" r="22"/><rect x="-44" y="8" width="100" height="22" rx="11"/></g>`;
}

function sunShape(r) {
  let rays = '';
  for (let i = 0; i < 8; i++) {
    rays += `<line x1="0" y1="${-r - 10}" x2="0" y2="${-r - 22}" stroke="#FFB300" stroke-width="7" stroke-linecap="round" transform="rotate(${i * 45})"/>`;
  }
  return `${rays}<circle r="${r}" fill="url(#sunG)"/>`;
}

function icon(kind, x, y) {
  const cloud = '#c3d1ea';
  let g;
  if (kind === 'sun') {
    g = sunShape(30);
  } else if (kind === 'partly') {
    g = `<g transform="translate(-18,-16) scale(.8)">${sunShape(24)}</g><g transform="translate(8,12)"><g transform="translate(0,3)" opacity=".35">${cloudShape('#000')}</g>${cloudShape(cloud)}</g>`;
  } else if (kind === 'fog') {
    g = `${cloudShape(cloud)}<g stroke="#b9c6dd" stroke-width="6" stroke-linecap="round"><line x1="-40" y1="42" x2="40" y2="42"/><line x1="-28" y1="56" x2="52" y2="56"/></g>`;
  } else if (kind === 'rain') {
    g = `<g transform="translate(0,-8)">${cloudShape('#c9d6ee')}</g><g stroke="#2F8BFF" stroke-width="7" stroke-linecap="round"><line x1="-24" y1="34" x2="-32" y2="54"/><line x1="0" y1="34" x2="-8" y2="54"/><line x1="24" y1="34" x2="16" y2="54"/></g>`;
  } else if (kind === 'storm') {
    g = `<g transform="translate(0,-8)">${cloudShape('#aab6cf')}</g><polygon points="6,22 -14,52 0,52 -8,76 22,40 6,40 16,22" fill="#FFC21A"/>`;
  } else {
    g = `<g transform="translate(0,3)" opacity=".25">${cloudShape('#000')}</g>${cloudShape(cloud)}`;
  }
  return `<g transform="translate(${x},${y})">${g}</g>`;
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, txt, size, weight, fill, anchor = 'start') =>
  `<text x="${x}" y="${y}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(txt)}</text>`;
const drop = (x, y, fill) =>
  `<path transform="translate(${x},${y})" d="M0 -14 C8 -4 12 2 12 8 A12 12 0 0 1 -12 8 C-12 2 -8 -4 0 -14Z" fill="${fill}"/>`;

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function dateLabel(now = new Date()) {
  const weekday = new Intl.DateTimeFormat('pt-BR', { timeZone: TIMEZONE, weekday: 'long' }).format(now);
  const dm = new Intl.DateTimeFormat('pt-BR', { timeZone: TIMEZONE, day: '2-digit', month: '2-digit' }).format(now);
  return `${weekday} · ${dm}`;
}

// Foto do bot redonda no cabecalho (data URI, cacheada). Sem a foto, o cartao sai sem ela.
let photoDataUri;
async function getBotPhotoDataUri() {
  if (photoDataUri !== undefined) return photoDataUri;
  try {
    const sharp = (await import('sharp')).default;
    const buffer = await sharp(BOT_PHOTO_PATH).resize(208, 208).png().toBuffer();
    photoDataUri = `data:image/png;base64,${buffer.toString('base64')}`;
  } catch {
    photoDataUri = null;
  }
  return photoDataUri;
}

function buildSvg(cities, photo) {
  const n = cities.length;
  const cardHeight = 320 + (n - 1) * ROW_HEIGHT;
  const height = 240 + cardHeight + 110;

  let rows = '';
  cities.forEach((c, i) => {
    const y = 330 + i * ROW_HEIGHT;
    const rainStrong = c.chuva >= 40;
    rows += `<g>
      ${i > 0 ? `<line x1="90" y1="${y - 22}" x2="990" y2="${y - 22}" stroke="rgba(60,60,67,.12)" stroke-width="2"/>` : ''}
      ${icon(c.kind, 150, y + 52)}
      ${text(250, y + 40, c.name, 40, 700, 'rgba(0,0,0,.85)')}
      ${text(250, y + 84, capitalize(c.desc), 28, 500, 'rgba(60,60,67,.65)')}
      ${text(800, y + 62, `${c.max}°`, 62, 800, 'rgba(0,0,0,.88)', 'end')}
      ${text(878, y + 62, `${c.min}°`, 40, 600, 'rgba(60,60,67,.55)')}
      <rect x="800" y="${y + 80}" width="190" height="40" rx="20" fill="url(#pill)" opacity="${rainStrong ? 1 : 0.55}"/>
      ${drop(826, y + 100, '#fff')}${text(922, y + 108, `${c.chuva}%`, 26, 700, '#fff', 'middle')}
    </g>`;
  });

  const header = photo
    ? `<g transform="translate(110,120)"><circle r="56" fill="#fff"/><g clip-path="url(#circ)"><image href="${photo}" x="-52" y="-52" width="104" height="104"/></g></g>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
  <defs>
    <linearGradient id="sunG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFD54A"/><stop offset="1" stop-color="#FF9F1A"/></linearGradient>
    <linearGradient id="bgLight" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#bcd8ff"/><stop offset=".55" stop-color="#e3d6f7"/><stop offset="1" stop-color="#cdeede"/></linearGradient>
    <linearGradient id="pill" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2F8BFF"/><stop offset="1" stop-color="#8F6BFF"/></linearGradient>
    <clipPath id="circ"><circle cx="0" cy="0" r="52"/></clipPath>
    <filter id="sh" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="14" stdDeviation="22" flood-color="#1f2937" flood-opacity=".16"/></filter>
  </defs>
  <rect width="${WIDTH}" height="${height}" fill="url(#bgLight)"/>
  <circle cx="140" cy="120" r="260" fill="#fff" opacity=".35"/><circle cx="1000" cy="${height - 100}" r="300" fill="#b894ff" opacity=".25"/>
  ${header}
  ${text(photo ? 190 : 60, 114, 'Bom dia, grupo!', 54, 800, 'rgba(0,0,0,.85)')}
  ${text(photo ? 190 : 60, 158, dateLabel(), 32, 500, 'rgba(60,60,67,.65)')}
  <rect x="50" y="240" width="980" height="${cardHeight}" rx="48" fill="#fff" fill-opacity=".6" filter="url(#sh)"/>
  ${rows}
  ${text(540, height - 54, 'Previsão para hoje · Open-Meteo', 24, 500, 'rgba(60,60,67,.55)', 'middle')}
</svg>`;
}

/**
 * Gera o cartao de previsao (PNG, Buffer) pras cidades vindas de
 * getWeatherData() em weather.js: [{ name, desc, kind, min, max, chuva }].
 * Lanca erro se nao houver cidades ou se a renderizacao falhar — quem chama
 * cai no texto simples.
 */
export async function renderWeatherCard(cities) {
  if (!cities || cities.length === 0) throw new Error('sem cidades pra desenhar');
  const photo = await getBotPhotoDataUri();
  const svg = buildSvg(cities, photo);
  const resvg = new Resvg(svg, {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' },
  });
  return resvg.render().asPng();
}
