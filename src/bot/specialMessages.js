// Mensagens especiais: nuvem de palavras, estreia do GTA VI, enxurrada de obrigados, noticias de games, Wrapped.

import { getBrasiliaNow, sentByBot, ROOT, fetchGroups, findMainGroupJid, getOpenAIClient } from './shared.js';
import { buildWordCloud } from '../wordcloud.js';
import { getTextsForDate, getAllRecordsForGroup } from '../db.js';
import { renderWordCloudCard } from '../wordcloudCard.js';
import path from 'path';
import { renderPremiereCard } from '../premiereCard.js';
import fs from 'fs';
import { pickThanksCount, buildThanksText, THANKS_INTERVAL_MS } from '../thanks.js';
import { TOPICS, sendTopicNews } from '../gameNews.js';
import { computeWrapped } from '../wrapped.js';
import { renderWrappedGroupCard, renderWrappedPersonCard } from '../wrappedCard.js';
import { readMemberPhoto } from '../birthdayPhotos.js';
import { getBirthdayPhotoBuffer } from './birthdayFlow.js';
import { photoToDataUri } from '../birthdayCard.js';

// Nuvem de palavras do dia (src/wordcloudCard.js), mandada logo depois da
// mensagem das 18h. Dia com poucas palavras diferentes nao rende nuvem — nao
// manda nada. Falha ao desenhar so vai pro log (a mensagem das 18h ja saiu).
export async function sendWordCloudToGroup(sock, groupJid, { force = false } = {}) {
  const { date } = getBrasiliaNow();
  const cloud = buildWordCloud(getTextsForDate(groupJid, date), 60);
  if (cloud.words.length < 5) {
    if (force) await sock.sendMessage(groupJid, { text: 'Poucas palavras hoje pra montar uma nuvem.' });
    return;
  }
  const image = renderWordCloudCard(cloud.words, date, cloud.totalMessages);
  const sent = await sock.sendMessage(groupJid, { image, caption: '☁️ Nuvem de palavras do dia' });
  if (sent?.key?.id) sentByBot.add(sent.key.id);
}

// !testarnuvem — manda a nuvem de hoje so no grupo onde foi digitado.
export async function commandTestarNuvem({ sock, groupJid }) {
  try {
    await sendWordCloudToGroup(sock, groupJid, { force: true });
  } catch (err) {
    console.error('Erro ao montar a nuvem de palavras:', err);
    await sock.sendMessage(groupJid, { text: 'Não consegui montar a nuvem agora.' });
  }
}

// Estreia do GTA VI: cartao (src/premiereCard.js) mandado uma unica vez, a
// meia-noite de 19/11/2026, marcando todo mundo do grupo (mentionAll). Um
// arquivo de estado evita mandar duas vezes; se o bot estava fora do ar a
// meia-noite, manda assim que reconectar (ate o meio-dia do mesmo dia).
const PREMIERE_DATE = '2026-11-19';

const PREMIERE_STATE_FILE = path.join(ROOT, 'estreia_state.json');

const PREMIERE_CAPTION = '🌴🎮 *É HOJE!* Bem-vindos a *Vice City*! 🌅';

async function sendPremiereCard(sock, { onlyGroupJid = null, mentionAll = true } = {}) {
  const image = await renderPremiereCard();
  const groupJids = onlyGroupJid ? [onlyGroupJid] : Object.keys(await fetchGroups(sock));
  for (const groupJid of groupJids) {
    try {
      let sent;
      try {
        sent = await sock.sendMessage(groupJid, { image, caption: PREMIERE_CAPTION, ...(mentionAll ? { mentionAll: true } : {}) });
      } catch (err) {
        console.error(`Erro ao marcar todos no cartao da estreia (${groupJid}), mandando sem marcar:`, err);
        sent = await sock.sendMessage(groupJid, { image, caption: PREMIERE_CAPTION });
      }
      if (sent?.key?.id) sentByBot.add(sent.key.id);
    } catch (err) {
      console.error(`Erro ao enviar o cartao da estreia para ${groupJid}:`, err);
    }
  }
}

export async function checkAndSendPremiere(sock) {
  const { date, time } = getBrasiliaNow();
  // % 24: algumas versoes do Intl devolvem "24:00" a meia-noite.
  if (date !== PREMIERE_DATE || Number(time.slice(0, 2)) % 24 >= 12) return;
  try {
    if (JSON.parse(fs.readFileSync(PREMIERE_STATE_FILE, 'utf-8')).sent) return;
  } catch {
    // sem arquivo de estado: ainda nao foi mandado
  }
  fs.writeFileSync(PREMIERE_STATE_FILE, JSON.stringify({ sent: true, at: new Date().toISOString() }));
  await sendPremiereCard(sock);
}

// !testarestreia — manda o cartao da estreia so no grupo onde foi digitado (sem marcar todo mundo).
export async function commandTestarEstreia({ sock, groupJid }) {
  await sendPremiereCard(sock, { onlyGroupJid: groupJid, mentionAll: false });
}

// Enxurrada de obrigados: de 8 a 12 mensagens, uma a cada 2 s, marcando o alvo.
export async function sendThanksFlood(sock, groupJid, targetJid) {
  const count = pickThanksCount();
  for (let i = 0; i < count; i++) {
    const sent = await sock.sendMessage(groupJid, { text: buildThanksText(targetJid), mentions: [targetJid] });
    if (sent?.key?.id) sentByBot.add(sent.key.id);
    if (i < count - 1) await new Promise((resolve) => setTimeout(resolve, THANKS_INTERVAL_MS));
  }
}

// Noticias de games no grupo principal: 12h e 19h (cron abaixo). A IA escolhe a
// melhor candidata dos feeds (src/gameNews.js) e o link sai com a miniatura.
export async function sendGameNews(sock, { groupJid = null } = {}) {
  const target = groupJid || (await findMainGroupJid(sock));
  if (!target) return null;
  const topic = TOPICS.find((t) => t.key === 'games');
  return sendTopicNews(sock, target, getOpenAIClient(), topic, { onSent: (sent) => sent?.key?.id && sentByBot.add(sent.key.id) });
}

// !testarnoticias — manda uma noticia de games agora, so no grupo onde foi digitado, e conta o que achou.
export async function commandTestarNoticias({ sock, groupJid }) {
  try {
    const result = await sendGameNews(sock, { groupJid });
    const fontes = (result?.diagnostics || []).map((d) => (d.ok ? `${d.source}: ${d.items} itens` : `${d.source}: FALHOU (${d.error})`)).join(' | ');
    if (!result?.sent) await sock.sendMessage(groupJid, { text: `Não mandei notícia: ${result?.reason || 'sem resultado'}.\nFontes: ${fontes}` });
  } catch (err) {
    console.error('Erro ao mandar noticia de games:', err);
    await sock.sendMessage(groupJid, { text: 'Não consegui mandar a notícia agora (veja o log).' });
  }
}

// Bothierry Wrapped: o ano em numeros. "!wrapped" manda o cartao de quem digitou,
// "!wrapped grupo" o do grupo (que tambem sai sozinho em 31/12, ver cron abaixo).
export async function sendWrappedGroup(sock, groupJid) {
  const year = Number(getBrasiliaNow().date.slice(0, 4));
  const wrapped = computeWrapped(getAllRecordsForGroup(groupJid), year);
  if (!wrapped) return sock.sendMessage(groupJid, { text: `Ainda não tenho mensagens de ${year} pra montar o Wrapped.` });
  const image = renderWrappedGroupCard(wrapped.group, wrapped.since);
  const sent = await sock.sendMessage(groupJid, { image, caption: `🎁 *Bothierry Wrapped ${year}* — o ano do grupo em números! Digite *!wrapped* pra ver o seu.` });
  if (sent?.key?.id) sentByBot.add(sent.key.id);
  return sent;
}

export async function commandWrapped({ sock, groupJid, msg, args }) {
  if (/^grupo$/i.test(String(args ?? '').trim())) return sendWrappedGroup(sock, groupJid);

  const senderJid = msg.key.participant || msg.key.remoteJid;
  const year = Number(getBrasiliaNow().date.slice(0, 4));
  const wrapped = computeWrapped(getAllRecordsForGroup(groupJid), year);
  const stats = wrapped?.people.get(senderJid);
  if (!stats) return sock.sendMessage(groupJid, { text: `Não achei mensagens suas em ${year} pra montar o seu Wrapped.` }, { quoted: msg });

  let photoUri = null;
  try {
    const buffer = readMemberPhoto(senderJid) || (await getBirthdayPhotoBuffer(sock, senderJid));
    if (buffer) photoUri = await photoToDataUri(buffer);
  } catch (err) {
    console.error('Erro ao preparar a foto do Wrapped:', err);
  }
  const image = renderWrappedPersonCard(stats, year, photoUri);
  const sent = await sock.sendMessage(groupJid, { image, caption: `🎁 Seu Bothierry Wrapped ${year}, ${stats.name}!` }, { quoted: msg });
  if (sent?.key?.id) sentByBot.add(sent.key.id);
  return sent;
}
