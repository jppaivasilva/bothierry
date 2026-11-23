// QR de pareamento do WhatsApp, pra mostrar no painel (so admin) quando o bot
// estiver deslogado e esperando alguem ler o QR no celular. O QR gira a cada
// ~20s: guardamos o ultimo recebido e o painel consulta de tempos em tempos.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// Mesma biblioteca que o qrcode-terminal ja usa pra desenhar no terminal.
const QRCode = require('qrcode-terminal/vendor/QRCode');
const { L } = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

const STALE_AFTER_MS = 90 * 1000; // um QR mais velho que isso nao serve mais
let current = null; // { qr, at }

export function setPairingQr(qr) {
  current = { qr, at: Date.now() };
}

export function clearPairingQr() {
  current = null;
}

/** O QR atual, ou null se nao ha (conectado) ou se ficou velho demais. */
export function getPairingQr() {
  return current && Date.now() - current.at < STALE_AFTER_MS ? current : null;
}

/** Desenha o QR como SVG (string), com margem de 4 modulos, pronto pra colocar na pagina. */
export function qrToSvg(qr, moduleSize = 8) {
  const code = new QRCode(-1, L);
  code.addData(qr);
  code.make();
  const count = code.getModuleCount();
  const margin = 4;
  const size = (count + margin * 2) * moduleSize;
  let rects = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (code.isDark(r, c)) rects += `<rect x="${(c + margin) * moduleSize}" y="${(r + margin) * moduleSize}" width="${moduleSize}" height="${moduleSize}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
