// Favicon do painel: a foto do bot, redonda (a foto original tem cantos
// brancos, que aqui viram transparentes), em PNG nos tamanhos que o navegador
// pede. Gerado uma vez por tamanho e guardado em memoria.
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT_PHOTO_PATH = path.join(__dirname, '..', 'assets', 'bot-photo.png');
const cache = new Map();

export const FAVICON_TAGS =
  '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />' +
  '<link rel="shortcut icon" href="/favicon.ico" />' +
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />';

// Caminho -> tamanho em px. /favicon.ico responde PNG (os navegadores aceitam).
const SIZES = { '/favicon.ico': 48, '/favicon-32.png': 32, '/apple-touch-icon.png': 180 };

/** PNG do favicon pra esse caminho, ou null se o caminho nao e de favicon. */
export async function getFavicon(pathname) {
  const size = SIZES[pathname];
  if (!size) return null;
  if (cache.has(size)) return cache.get(size);
  const sharp = (await import('sharp')).default;
  const mask = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`);
  // O apple-touch-icon nao aceita transparencia (vira preto no iOS): ali a foto vai quadrada.
  let image = sharp(BOT_PHOTO_PATH).resize(size, size, { fit: 'cover' }).ensureAlpha();
  if (pathname !== '/apple-touch-icon.png') image = image.composite([{ input: mask, blend: 'dest-in' }]);
  const png = await image.png().toBuffer();
  cache.set(size, png);
  return png;
}
