// EXPERIMENTO (desligado por padrao): postar um STATUS DE GRUPO (story do grupo, recurso novo do
// WhatsApp de 31/10/2026). O Baileys 7.0.0-rc14 conhece o formato (groupStatusMessageV2,
// contextInfo.isGroupStatus, StatusAttribution GROUP_STATUS) mas nao tem funcao pronta; montamos a
// mensagem na mao e mandamos por relayMessage com um no <meta is_group_status origin=group_status>,
// seguindo o que a comunidade reportou funcionar (Baileys discussion #2318 e issue #2903). Nao ha
// confirmacao oficial: por isso so o root usa (!statusgrupo) e ha 3 variantes pra descobrir qual peca
// faz o WhatsApp mostrar o status. Se o formato estiver errado, o esperado e o WhatsApp ignorar
// em silencio (como no !testarstory antigo) — nenhuma mensagem aparece pro grupo.
import crypto from 'crypto';
import { proto, prepareWAMessageMedia, generateMessageIDV2 } from '@whiskeysockets/baileys';

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
  const inner = content.imageMessage
    ? { imageMessage: { ...content.imageMessage, ...(content.caption ? { caption: content.caption } : {}), contextInfo } }
    : { extendedTextMessage: { text: content.text, backgroundArgb: 0xff1f6feb, font: 1, contextInfo } };
  return {
    message: { groupStatusMessageV2: { message: inner }, messageContextInfo: { messageSecret: secret } },
    additionalNodes: variant === 3 ? [] : [META_NODE],
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
