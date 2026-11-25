// Visao: quando alguem fala com o bot ENVIANDO uma foto/print/figurinha (com a
// marcacao na legenda) ou RESPONDENDO a uma, a imagem vai junto pra IA. A
// imagem e reduzida (lado maior 1024px, JPEG) pra custar pouco, nunca e
// gravada em disco e so vale pra aquela pergunta.
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { getSharp } from './shared.js';

const MAX_RAW_BYTES = 10 * 1024 * 1024;
const MEDIA_KEYS = ['imageMessage', 'stickerMessage'];

/** Acha a midia de imagem: na propria mensagem ou na mensagem citada. Devolve { target, key } ou null. */
export function findImageMedia(msg) {
  for (const key of MEDIA_KEYS) {
    if (msg.message?.[key]) return { target: msg, key };
  }
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo;
  const quoted = contextInfo?.quotedMessage;
  if (!quoted) return null;
  for (const key of MEDIA_KEYS) {
    if (quoted[key]) {
      return { target: { key: { remoteJid: msg.key.remoteJid, id: contextInfo.stanzaId, participant: contextInfo.participant }, message: quoted }, key };
    }
  }
  return null;
}

/** Reduz pra 1024px e converte pra JPEG (data URI base64). Funcao pura de buffer, testavel. */
export async function toVisionDataUri(buffer) {
  const sharp = await getSharp();
  const jpeg = await sharp(buffer).rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

/** Baixa e prepara a imagem da mensagem (ou da citada). null se nao ha imagem ou deu erro. */
export async function getImageForBot(msg) {
  const found = findImageMedia(msg);
  if (!found) return null;
  try {
    const size = Number(found.target.message?.[found.key]?.fileLength || 0);
    if (size > MAX_RAW_BYTES) return null;
    const buffer = await downloadMediaMessage(found.target, 'buffer', {});
    return await toVisionDataUri(buffer);
  } catch (err) {
    console.error('Erro ao baixar imagem pro bot:', err);
    return null;
  }
}
