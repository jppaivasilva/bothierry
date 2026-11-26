// !statusgrupo — EXPERIMENTO, so root, desligado por padrao (GROUP_STATUS_ENABLED=1 no .env).
//   !statusgrupo [1|2|3] texto...        posta um status de texto
//   (respondendo a uma foto) !statusgrupo [1|2|3] legenda   posta a foto como status
//   !statusgrupo apagar                  apaga o ultimo status que o bot postou
import fs from 'fs';
import path from 'path';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { postGroupStatus, revokeGroupStatus, VARIANTS } from './groupStatus.js';
import { isRoot, rootNumbers } from './root.js';
import { botState, ROOT } from './shared.js';
import { getQuotedMedia } from './basicCommands.js';
import { logBotAction } from '../botLog.js';

const STATE_FILE = process.env.GROUP_STATUS_STATE_FILE || path.join(ROOT, 'group_status_state.json');
const loadLast = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')).last || null;
  } catch {
    return null;
  }
};
const saveLast = (last) => fs.writeFileSync(STATE_FILE, JSON.stringify({ last }));

export async function commandStatusGrupo({ sock, groupJid, senderJid, args, msg }) {
  const reply = (text) => sock.sendMessage(groupJid, { text }, { quoted: msg });
  if (process.env.GROUP_STATUS_ENABLED !== '1') return reply('O teste de status de grupo está desligado (GROUP_STATUS_ENABLED=1 no .env da VM liga).');
  if (!isRoot({ senderJid, msg })) {
    if (rootNumbers().length === 0) {
      // ninguem configurado: manda no PRIVADO o numero que o bot enxerga, pra colocar em ROOT_NUMBERS
      await sock.sendMessage(senderJid, { text: `Pra liberar comandos de root, ponha no .env da VM:\nROOT_NUMBERS=${String(senderJid).split('@')[0].split(':')[0]}\ne reinicie o bot (pm2 restart Bothierry --update-env).` }).catch(() => {});
    }
    return reply('Esse é só pro root 🔒');
  }

  const live = botState.sock || sock; // o socket vivo, nao o da epoca em que a mensagem chegou
  let rest = String(args || '').trim();

  if (/^apagar\b/i.test(rest)) {
    const last = loadLast();
    if (!last) return reply('Não tenho nenhum status postado pra apagar.');
    try {
      await revokeGroupStatus(live, last.groupJid, last.id);
      return reply(`Pedi pro WhatsApp apagar o status ${last.id}. Confere na aba de status do grupo.`);
    } catch (err) {
      return reply(`Não consegui apagar: ${err?.message || err}`);
    }
  }

  let variant = 1;
  const m = /^([123])\b\s*/.exec(rest);
  if (m) {
    variant = Number(m[1]);
    rest = rest.slice(m[0].length);
  }
  const quotedImage = getQuotedMedia(msg, 'imageMessage');
  if (!quotedImage && !rest) {
    return reply(`Use: *!statusgrupo texto do status* ou responda uma foto com *!statusgrupo legenda*.\nVariantes (teste): ${Object.entries(VARIANTS).map(([k, v]) => `${k} = ${v}`).join(' | ')} — ex.: !statusgrupo 2 oi\nApagar: *!statusgrupo apagar*`);
  }
  try {
    const image = quotedImage ? await downloadMediaMessage(quotedImage, 'buffer', {}) : null;
    const { id } = await postGroupStatus(live, groupJid, { text: rest, image, caption: rest || undefined, variant });
    saveLast({ groupJid, id, variant, ts: Date.now() });
    logBotAction({ tipo: 'grupo', resumo: `postei (teste) um status de grupo, variante ${variant}${image ? ' com imagem' : ''}` });
    return reply(`Status (variante ${variant}) enviado ao WhatsApp, id ${id}. Abre a aba de status do grupo: se não apareceu, o WhatsApp ignorou essa variante — tenta !statusgrupo ${variant === 3 ? 1 : variant + 1} ...`);
  } catch (err) {
    console.error('Erro ao postar status de grupo:', err);
    return reply(`Falhou: ${err?.message || err}`);
  }
}
