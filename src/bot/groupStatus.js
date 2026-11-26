// STATUS DE GRUPO: postar um STATUS DE GRUPO (story do grupo, recurso novo do
// WhatsApp de 31/10/2026). TEXTO ja foi testado e funciona; foto: ver buildGroupStatus. O Baileys 7.0.0-rc14 conhece o formato (groupStatusMessageV2,
// contextInfo.isGroupStatus, StatusAttribution GROUP_STATUS) mas nao tem funcao pronta; montamos a
// mensagem na mao e mandamos por relayMessage com um no <meta is_group_status origin=group_status>,
// seguindo o que a comunidade reportou funcionar (Baileys discussion #2318 e issue #2903). Nao ha
// confirmacao oficial: por isso so o root usa (!statusgrupo) e ha 3 variantes pra descobrir qual peca
// faz o WhatsApp mostrar o status. Se o formato estiver errado, o esperado e o WhatsApp ignorar
// em silencio (como no !testarstory antigo) — nenhuma mensagem aparece pro grupo.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { proto, prepareWAMessageMedia, generateMessageIDV2 } from '@whiskeysockets/baileys';
import { logBotAction } from '../botLog.js';
import { botState, ROOT } from './shared.js';

const GROUP_STATUS_ATTRIBUTION = 5; // proto.StatusAttribution.Type.GROUP_STATUS
const META_NODE = { tag: 'meta', attrs: { is_group_status: 'true', origin: 'group_status' } };

export const VARIANTS = {
  1: 'receita completa (V2 + atribuicao GROUP_STATUS + messageSecret + no meta)',
  2: 'sem a atribuicao GROUP_STATUS (so isGroupStatus + messageSecret + no meta)',
  3: 'sem o no meta (V2 + atribuicao + messageSecret)',
};

const digits = (jid) => String(jid ?? '').split('@')[0].split(':')[0];

function contextInfoFor(variant, authorJid) {
  const ctx = { isGroupStatus: true };
  if (variant !== 2) ctx.statusAttributions = [{ type: GROUP_STATUS_ATTRIBUTION, groupStatus: { authorJid } }];
  return ctx;
}

/**
 * Monta a mensagem (funcao pura, testavel). `content`: { text } ou { imageMessage, caption }.
 * Devolve { message (objeto pronto pra proto.Message.fromObject), additionalNodes }.
 */
export function buildGroupStatus({ content, authorJid, variant = 1, secret = crypto.randomBytes(32) }) {
  if (!VARIANTS[variant]) throw new Error(`variante invalida (use ${Object.keys(VARIANTS).join(', ')})`);
  const contextInfo = contextInfoFor(variant, authorJid);
  const messageContextInfo = { messageSecret: secret };
  const additionalNodes = variant === 3 ? [] : [META_NODE];
  if (content.imageMessage) {
    // FOTO: a imageMessage fica no TOPO, sem o embrulho groupStatusMessageV2. O Baileys marca o tipo de
    // midia (mediatype="image") olhando so o topo da mensagem (getMediaType em messages-send.js); dentro do
    // embrulho o marcador some e o WhatsApp descarta a foto em silencio (foi o que aconteceu no 1o teste).
    return { message: { imageMessage: { ...content.imageMessage, ...(content.caption ? { caption: content.caption } : {}), contextInfo }, messageContextInfo }, additionalNodes };
  }
  // TEXTO: nao tem tipo de midia, entao o embrulho V2 funciona (testado: apareceu no grupo).
  return {
    message: { groupStatusMessageV2: { message: { extendedTextMessage: { text: content.text, backgroundArgb: 0xff1f6feb, font: 1, contextInfo } } }, messageContextInfo },
    additionalNodes,
  };
}

/** Posta o status no grupo. content: { text } ou { image: Buffer, caption }. Devolve { id }. */
export async function postGroupStatus(sock, groupJid, { text, image, caption, variant = 1 }) {
  const authorJid = sock.user?.id ? `${digits(sock.user.id)}@s.whatsapp.net` : undefined;
  let content;
  if (image) {
    const prepared = await prepareWAMessageMedia({ image }, { upload: sock.waUploadToServer });
    content = { imageMessage: prepared.imageMessage, caption };
  } else {
    content = { text };
  }
  const { message, additionalNodes } = buildGroupStatus({ content, authorJid, variant });
  const messageId = generateMessageIDV2(sock.user?.id);
  await sock.relayMessage(groupJid, proto.Message.fromObject(message), { messageId, additionalNodes });
  return { id: messageId };
}

/** Apaga um status que o bot postou (revoke com o no meta; edit=7 = autor). */
export async function revokeGroupStatus(sock, groupJid, messageId) {
  const message = proto.Message.fromObject({ protocolMessage: { key: { remoteJid: groupJid, fromMe: true, id: messageId }, type: proto.Message.ProtocolMessage.Type.REVOKE } });
  await sock.relayMessage(groupJid, message, { messageId: generateMessageIDV2(sock.user?.id), additionalAttributes: { edit: '7' }, additionalNodes: [META_NODE] });
}

// ---------------- liga/desliga e cartoes automaticos ----------------
/** Ligado por padrao; GROUP_STATUS_ENABLED=0 no .env desliga tudo (comando e automaticos). */
export const statusEnabled = () => process.env.GROUP_STATUS_ENABLED !== '0';

/** Cartoes que saem sozinhos como status. Padrao: previsao e aniversario; GROUP_STATUS_AUTO no .env troca a lista (vazio = nenhum). */
export const autoStatusKinds = () => {
  const raw = process.env.GROUP_STATUS_AUTO;
  return (raw === undefined ? 'previsao,aniversario' : raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
};

// ---------------- registro do que o bot postou (pra poder apagar) ----------------
const STATE_FILE = process.env.GROUP_STATUS_STATE_FILE || path.join(ROOT, 'group_status_state.json');
const MAX_POSTS = 30;
const DAY_MS = 24 * 3600 * 1000;

function loadPosts() {
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return Array.isArray(d.posts) ? d.posts : [];
  } catch {
    return [];
  }
}
const savePosts = (posts) => fs.writeFileSync(STATE_FILE, JSON.stringify({ posts: posts.slice(-MAX_POSTS) }));

/** Guarda um status postado (quem pediu, o que era) pra !statusgrupo apagar. */
export function rememberPost({ groupJid, id, authorJid = null, authorName = null, kind = 'manual' }) {
  try {
    savePosts([...loadPosts(), { groupJid, id, authorJid, authorName, kind, ts: Date.now() }]);
  } catch (err) {
    console.error('Erro ao registrar o status postado:', err);
  }
}

/** Ultimo status ainda no ar (menos de 24 h) que essa pessoa pode apagar: o dela; o root apaga o ultimo de qualquer um. */
export function findPostToDelete({ authorJid, root = false }, now = Date.now()) {
  const alive = loadPosts().filter((p) => now - p.ts < DAY_MS);
  const mine = alive.filter((p) => p.authorJid && p.authorJid === authorJid);
  return (root ? alive : mine).at(-1) || null;
}
export function forgetPost(id) {
  savePosts(loadPosts().filter((p) => p.id !== id));
}

/**
 * Posta um cartao como status de grupo SE o recurso estiver ligado e esse tipo estiver na lista automatica
 * (ou force=true). Nunca lanca erro: se o WhatsApp recusar, o cartao normal no chat ja saiu e nada mais e afetado.
 */
export async function maybePostAutoStatus(sock, groupJid, kind, { image, caption }, { force = false } = {}) {
  if (!statusEnabled() || !image) return null;
  if (!force && !autoStatusKinds().includes(kind)) return null;
  try {
    const { id } = await postGroupStatus(botState.sock || sock, groupJid, { image, caption });
    rememberPost({ groupJid, id, kind });
    logBotAction({ tipo: 'grupo', resumo: `postei o cartao de ${kind} como status do grupo` });
    return id;
  } catch (err) {
    console.error(`Erro ao postar o status de grupo (${kind}) — o cartao normal ja foi enviado:`, err?.message || err);
    return null;
  }
}
