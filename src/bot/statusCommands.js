// !statusgrupo — posta um STATUS DE GRUPO (story do grupo) pelo bot.
//   !statusgrupo texto do status        status de texto
//   (respondendo a uma foto) !statusgrupo [legenda]    a foto vira status
//   !statusgrupo apagar                 apaga o ultimo status SEU (o root apaga o ultimo de qualquer um)
// Em producao: qualquer membro usa (1 vez a cada 5 min por pessoa; root sem limite). STATUS_GRUPO_ONLY_ROOT=1
// no .env restringe ao root; GROUP_STATUS_ENABLED=0 desliga tudo. O status some sozinho em 24 h.
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { postGroupStatus, revokeGroupStatus, statusEnabled, rememberPost, findPostToDelete, forgetPost, VARIANTS } from './groupStatus.js';
import { isRoot } from './root.js';
import { botState } from './shared.js';
import { getQuotedMedia } from './basicCommands.js';
import { logBotAction } from '../botLog.js';
import { formatDisplayName } from '../displayNames.js';

export const STATUS_COOLDOWN_MS = 5 * 60_000;
export const STATUS_MAX_TEXT = 300;
const lastPostBySender = new Map();

export async function commandStatusGrupo({ sock, groupJid, senderJid, senderName, args, msg }) {
  const reply = (text) => sock.sendMessage(groupJid, { text }, { quoted: msg });
  if (!statusEnabled()) return reply('O status de grupo está desligado no momento (GROUP_STATUS_ENABLED=0 no .env).');
  const root = isRoot({ senderJid, msg });
  if (process.env.STATUS_GRUPO_ONLY_ROOT === '1' && !root) return reply('Por enquanto o !statusgrupo é só pro root 🔒');

  const live = botState.sock || sock; // o socket vivo, nao o da epoca em que a mensagem chegou
  let rest = String(args || '').trim();

  if (/^apagar\b/i.test(rest)) {
    const post = findPostToDelete({ authorJid: senderJid, root });
    if (!post) return reply(root ? 'Não tenho nenhum status no ar pra apagar.' : 'Não achei nenhum status seu no ar (só dá pra apagar os seus, até 24 h depois).');
    try {
      await revokeGroupStatus(live, post.groupJid, post.id);
      forgetPost(post.id);
      return reply('Pronto, pedi pro WhatsApp apagar o status 🧹');
    } catch (err) {
      return reply(`Não consegui apagar: ${err?.message || err}`);
    }
  }

  // As variantes (1|2|3) existem so pra depuracao do root.
  let variant = 1;
  const m = root ? /^([123])\b\s*/.exec(rest) : null;
  if (m) {
    variant = Number(m[1]);
    rest = rest.slice(m[0].length);
  }
  const quotedImage = getQuotedMedia(msg, 'imageMessage');
  if (!quotedImage && !rest) {
    return reply('Pra postar um *status no grupo*:\n• *!statusgrupo seu texto* → status de texto\n• responda uma *foto* com *!statusgrupo* (ou com uma legenda) → a foto vira status\n• *!statusgrupo apagar* → remove o seu último status');
  }
  if (rest.length > STATUS_MAX_TEXT) return reply(`Esse texto é grande demais pra um status (máximo ${STATUS_MAX_TEXT} caracteres).`);

  const now = Date.now();
  const wait = (lastPostBySender.get(senderJid) || 0) + STATUS_COOLDOWN_MS - now;
  if (!root && wait > 0) return reply(`Calma, um status por vez 😅 tenta de novo em ${Math.ceil(wait / 60000)} min.`);

  try {
    const image = quotedImage ? await downloadMediaMessage(quotedImage, 'buffer', {}) : null;
    const { id } = await postGroupStatus(live, groupJid, { text: rest, image, caption: rest || undefined, variant });
    lastPostBySender.set(senderJid, now);
    rememberPost({ groupJid, id, authorJid: senderJid, authorName: senderName, kind: image ? 'foto' : 'texto' });
    const nome = formatDisplayName(senderName || '');
    logBotAction({ tipo: 'grupo', jid: senderJid, nome, resumo: `${nome} pediu e eu postei ${image ? 'uma foto' : 'um texto'} como status do grupo` });
    return reply(`Pronto, postei no status do grupo ✅ (some sozinho em 24 h; *!statusgrupo apagar* remove)${variant !== 1 ? ` [variante ${variant}: ${VARIANTS[variant]}]` : ''}`);
  } catch (err) {
    console.error('Erro ao postar status de grupo:', err);
    return reply(`Não consegui postar o status: ${err?.message || err}`);
  }
}
