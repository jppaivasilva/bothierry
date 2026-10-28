// Cache local das fotos de perfil dos membros do grupo, buscadas via Baileys
// (sock.profilePictureUrl) e salvas em disco — usado pelo painel pra mostrar
// a foto de cada pessoa ao lado do nome na aba Atividade.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Tamanho final de cada foto de perfil salva — e so exibida como um circulo
// pequeno no painel (~32-40px), entao nao faz sentido guardar a imagem
// original do WhatsApp (que costuma vir na casa de 300-400KB). Redimensionar
// pra isso no cache deixa o carregamento do painel muito mais rapido.
const AVATAR_SIZE_PX = 128;
const AVATAR_JPEG_QUALITY = 82;

// Corta e redimensiona com o ImageMagick (`convert`, ja instalado na VM) —
// evita adicionar uma dependencia npm pesada (ex: sharp) so pra isso. Versao
// assincrona (execFile, nao execFileSync) pra nao travar o event loop
// enquanto o processo externo roda — importante numa VM com CPU/RAM
// apertados, rodando durante a reconexao com o WhatsApp.
async function resizeAvatar(filePath) {
  try {
    await execFileAsync('convert', [
      filePath,
      '-resize', `${AVATAR_SIZE_PX}x${AVATAR_SIZE_PX}^`,
      '-gravity', 'center',
      '-extent', `${AVATAR_SIZE_PX}x${AVATAR_SIZE_PX}`,
      '-strip',
      '-quality', String(AVATAR_JPEG_QUALITY),
      filePath,
    ]);
  } catch {
    // Sem ImageMagick disponivel (ex: ambiente de dev no Windows) — mantem a
    // imagem original em vez de quebrar o sync inteiro por causa disso.
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AVATARS_DIR = path.join(__dirname, '..', 'avatars');

// Troca caracteres que nao da pra usar em nome de arquivo (ex: "@" do JID)
// por "_", pra poder salvar "5511999999999@s.whatsapp.net" como arquivo.
function sanitizeJid(jid) {
  return jid.replace(/[^a-zA-Z0-9.-]/g, '_');
}

export function getAvatarPath(jid) {
  return path.join(AVATARS_DIR, `${sanitizeJid(jid)}.jpg`);
}

// So rebusca uma foto se o cache tiver mais de X dias — fotos de perfil nao
// mudam toda hora, entao nao faz sentido bater na API do WhatsApp toda vez.
const AVATAR_CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function isCacheStale(filePath) {
  if (!fs.existsSync(filePath)) return true;
  const { mtimeMs, size } = fs.statSync(filePath);
  // Arquivo com conteudo real (foto de verdade, seja baixada do WhatsApp ou
  // colocada manualmente) nunca e considerado velho — so os "marcadores"
  // vazios (tentativa anterior que falhou, ex: not-authorized) expiram, pra
  // poder tentar de novo depois. Sem essa checagem de tamanho, uma foto que
  // a gente colocou na mao seria apagada e re-tentada (e provavelmente
  // falharia nessa pessoa de novo) depois de AVATAR_CACHE_MAX_AGE_MS.
  if (size > 0) return false;
  return Date.now() - mtimeMs > AVATAR_CACHE_MAX_AGE_MS;
}

/**
 * Busca e cacheia as fotos de perfil de uma lista de JIDs — ignora quem ja
 * tem cache recente, e segue em frente (sem quebrar o lote) se algum contato
 * nao tiver foto ou bloquear por privacidade (Baileys lanca erro nesses
 * casos, o que e esperado, nao um bug).
 */
export async function syncAvatars(sock, jids) {
  if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });

  let updated = 0;
  for (const jid of jids) {
    const filePath = getAvatarPath(jid);
    if (!isCacheStale(filePath)) continue;

    try {
      const url = await sock.profilePictureUrl(jid, 'preview');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`status HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(filePath, buffer);
      await resizeAvatar(filePath);
      updated++;
    } catch {
      // Sem foto de perfil ou privacidade bloqueando (erro "not-authorized"
      // do WhatsApp quando a pessoa restringe quem ve a foto) — normal, so
      // pula. Marca um arquivo vazio como "tentado" pra nao ficar
      // re-tentando essa mesma pessoa a cada sync (ate o cache expirar).
      fs.writeFileSync(filePath, '');
    }
  }
  return { updated, total: jids.length };
}
