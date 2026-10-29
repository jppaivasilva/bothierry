// Fotos enviadas na mao (tela de admin do painel) pra aniversariantes que nao
// tem foto de perfil no WhatsApp — por exemplo, quem nao e membro do grupo.
// Ficam so na VM (birthday_photos/, fora do git): foto de gente nao vai pro
// repositorio publico. Uma foto enviada vale mais que a do WhatsApp.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeName } from './birthdayLinks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BIRTHDAY_PHOTOS_DIR = path.join(__dirname, '..', 'birthday_photos');
const PHOTO_SIZE_PX = 700;

// Nome do arquivo a partir do nome do aniversariante (sem acento, so letras/numeros).
function slug(name) {
  return normalizeName(name).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'sem_nome';
}

export function birthdayPhotoPath(name) {
  return path.join(BIRTHDAY_PHOTOS_DIR, `${slug(name)}.jpg`);
}

/** Versao (mtime em ms) da foto enviada, ou null se nao ha. Serve pra furar o cache do navegador. */
export function birthdayPhotoVersion(name) {
  try {
    const { mtimeMs, size } = fs.statSync(birthdayPhotoPath(name));
    return size > 0 ? Math.round(mtimeMs) : null;
  } catch {
    return null;
  }
}

/** Foto enviada (Buffer) ou null. */
export function readBirthdayPhoto(name) {
  try {
    const buffer = fs.readFileSync(birthdayPhotoPath(name));
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

/**
 * Salva a foto enviada: confere que e imagem de verdade, corrige a rotacao do
 * celular (EXIF), corta quadrado e reduz — nunca guarda o arquivo original.
 * Lanca erro se nao for uma imagem valida.
 */
export async function saveBirthdayPhoto(name, buffer) {
  const jpeg = await toSquareJpeg(buffer);
  fs.mkdirSync(BIRTHDAY_PHOTOS_DIR, { recursive: true });
  fs.writeFileSync(birthdayPhotoPath(name), jpeg);
}

// Confere que e imagem, corrige a rotacao (EXIF), corta quadrado mirando no rosto e reduz.
async function toSquareJpeg(buffer) {
  const sharp = (await import('sharp')).default;
  return sharp(buffer, { failOn: 'error' })
    .rotate()
    .resize(PHOTO_SIZE_PX, PHOTO_SIZE_PX, { fit: 'cover', position: sharp.strategy.attention })
    .jpeg({ quality: 86 })
    .toBuffer();
}

export function deleteBirthdayPhoto(name) {
  try {
    fs.unlinkSync(birthdayPhotoPath(name));
  } catch {
    // ja nao existia
  }
}

// ---------- fotos por MEMBRO (jid): enviadas pela lista de membros do painel ----------
// Valem pra qualquer membro (tenha aniversario ou nao) e vencem a foto do
// WhatsApp e a enviada pelo nome do aniversariante.
export const MEMBER_PHOTOS_DIR = path.join(__dirname, '..', 'member_photos');

export function memberPhotoPath(jid) {
  return path.join(MEMBER_PHOTOS_DIR, `${String(jid).replace(/[^a-zA-Z0-9.-]/g, '_')}.jpg`);
}

export function memberPhotoVersion(jid) {
  try {
    const { mtimeMs, size } = fs.statSync(memberPhotoPath(jid));
    return size > 0 ? Math.round(mtimeMs) : null;
  } catch {
    return null;
  }
}

export function readMemberPhoto(jid) {
  try {
    const buffer = fs.readFileSync(memberPhotoPath(jid));
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

export async function saveMemberPhoto(jid, buffer) {
  const jpeg = await toSquareJpeg(buffer);
  fs.mkdirSync(MEMBER_PHOTOS_DIR, { recursive: true });
  fs.writeFileSync(memberPhotoPath(jid), jpeg);
}

export function deleteMemberPhoto(jid) {
  try {
    fs.unlinkSync(memberPhotoPath(jid));
  } catch {
    // ja nao existia
  }
}
