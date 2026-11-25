// Mensagens automaticas do dia: bom dia, fim de expediente, ranking e resumo semanais, mensagens agendadas.

import { getBrasiliaNow, getHolidayName, TIMEZONE, fetchGroups, sentByBot, formatDateBR, addDaysBR, isBrazilianHoliday, debugLog, EVENING_HOUR, MORNING_HOUR, DASHBOARD_URL, getTimestampBR, AUDIOS_DIR } from './shared.js';
import { morningTheme, morningGreeting, isWeekend } from '../morning.js';
import { getWeatherData, formatWeatherBlock } from '../weather.js';
import { renderWeatherCard } from '../weatherCard.js';
import { formatDisplayName } from '../displayNames.js';
import { getWindowSummary, getCountsSince, getCountsBetween } from '../db.js';
import { readMemberPhoto } from '../birthdayPhotos.js';
import { getBirthdayPhotoBuffer } from './birthdayFlow.js';
import { photoToDataUri } from '../birthdayCard.js';
import { renderWeeklyCard } from '../weeklyCard.js';
import { getTopAudioSince } from '../audioUsage.js';
import { sendWordCloudToGroup } from './specialMessages.js';
import { getDueMessages, markScheduledMessageSent } from '../scheduled.js';
import path from 'path';
import fs from 'fs';
import { getAudioMimeType } from './audioCommands.js';

// Mensagem automatica das 8h, mandada em todos os grupos que o bot participa.
// So em dia util (o cron ja restringe a segunda-sexta) e fora de feriado nacional.
// Bom dia: cartao de previsao em imagem (src/weatherCard.js) com o texto como
// legenda. Se a previsao ou a imagem falharem, cai no texto com o bloco de
// clima (ou so o bom dia, se nem a previsao veio). onlyGroupJid manda so num
// grupo (usado pelo !testarbomdia).
export async function sendMorningMessage(sock, onlyGroupJid = null, themeOverride = null) {
  const { date: today } = getBrasiliaNow();
  const theme = themeOverride || morningTheme(today);
  const holidayName = await getHolidayName(today);

  const diaSemana = new Intl.DateTimeFormat('pt-BR', { timeZone: TIMEZONE, weekday: 'long' }).format(new Date());
  let text = morningGreeting({ diaSemana, holidayName, weekend: isWeekend(today), theme });

  // Previsao do tempo e so um complemento — se a API estiver fora do ar, o
  // bom dia sai do mesmo jeito, so sem o clima.
  let weather = [];
  try {
    weather = await getWeatherData();
  } catch (err) {
    console.error('Erro ao buscar previsao do tempo pra mensagem de bom dia:', err);
  }

  let image = null;
  if (weather.length > 0) {
    try {
      image = await renderWeatherCard(weather, theme);
    } catch (err) {
      console.error('Erro ao montar o cartao de previsao (mandando em texto):', err);
      text += `\n\n${formatWeatherBlock(weather)}`;
    }
  }

  const groupJids = onlyGroupJid ? [onlyGroupJid] : Object.keys(await fetchGroups(sock));
  for (const groupJid of groupJids) {
    try {
      const sent = await sock.sendMessage(groupJid, image ? { image, caption: text } : { text });
      if (sent?.key?.id) sentByBot.add(sent.key.id);
    } catch (err) {
      console.error(`Erro ao enviar mensagem de bom dia para ${groupJid}:`, err);
    }
  }
}

// !testarbomdia — manda o bom dia so no grupo onde foi digitado (pra ver como fica).
// "!testarbomdia gtavi" mostra a versao tematica do lancamento do GTA VI.
export async function commandTestarBomDia({ sock, groupJid, args }) {
  const theme = String(args ?? '').trim().toLowerCase() === 'gtavi' ? 'gtavi' : null;
  await sendMorningMessage(sock, groupJid, theme);
}

// Resumo semanal: cartao grande (src/weeklyCard.js) com os ultimos 7 dias do
// grupo — campeao, top 5, total (vs semana anterior), horario de pico, links e
// audio mais usado. Cai pra texto se a imagem falhar. onlyGroupJid manda so num
// grupo (usado pelo !resumosemanal); grupo sem mensagens na semana e pulado.
function weeklyTextFallback(summary, rangeLabel) {
  const lines = [`📊 *Resumo da semana* (${rangeLabel})`, ''];
  summary.ranking.slice(0, 5).forEach((p, i) => lines.push(`${i + 1}. ${formatDisplayName(p.name)}: ${p.total} msgs`));
  lines.push('', `Total: ${summary.total} mensagens`);
  return lines.join('\n');
}

export async function sendWeeklySummary(sock, onlyGroupJid = null) {
  const untilTs = Math.floor(Date.now() / 1000);
  const sinceTs = untilTs - 7 * 24 * 60 * 60;
  const { date: today } = getBrasiliaNow();
  const rangeLabel = `${formatDateBR(addDaysBR(today, -7))} a ${formatDateBR(today)}`;
  const groupJids = onlyGroupJid ? [onlyGroupJid] : Object.keys(await fetchGroups(sock));

  for (const groupJid of groupJids) {
    try {
      const summary = getWindowSummary(groupJid, sinceTs, untilTs);
      if (!summary) {
        if (onlyGroupJid) await sock.sendMessage(groupJid, { text: 'Ninguém falou nos últimos 7 dias, não tenho o que resumir 😶' });
        continue;
      }
      let image = null;
      try {
        const champion = summary.ranking[0];
        let championPhotoUri = null;
        try {
          const buffer = readMemberPhoto(champion.jid) || (await getBirthdayPhotoBuffer(sock, champion.jid));
          if (buffer) championPhotoUri = await photoToDataUri(buffer);
        } catch (err) {
          console.error('Erro ao preparar a foto do campeao da semana:', err);
        }
        const diff = summary.prevTotal > 0 ? Math.round(((summary.total - summary.prevTotal) / summary.prevTotal) * 100) : null;
        const deltaLabel = diff === null ? 'primeira semana medida' : diff === 0 ? 'igual à semana passada' : `${Math.abs(diff)}% ${diff > 0 ? 'a mais' : 'a menos'} que a semana passada`;
        image = renderWeeklyCard({
          rangeLabel,
          total: summary.total,
          deltaLabel,
          peakHour: summary.peakHour,
          peakDayName: summary.peakDayName,
          linkMessages: summary.linkMessages,
          topLinkRepeats: summary.topLinkRepeats,
          audio: getTopAudioSince(sinceTs),
          ranking: summary.ranking.map((p) => ({ name: formatDisplayName(p.name), total: p.total })),
          championPhotoUri,
        });
      } catch (err) {
        console.error('Erro ao montar o cartao do resumo semanal (mandando em texto):', err);
      }
      const caption = `📊 Resumo da semana (${rangeLabel})`;
      const sent = await sock.sendMessage(groupJid, image ? { image, caption } : { text: weeklyTextFallback(summary, rangeLabel) });
      if (sent?.key?.id) sentByBot.add(sent.key.id);
    } catch (err) {
      console.error(`Erro ao enviar resumo semanal para ${groupJid}:`, err);
    }
  }
}

// !resumosemanal — manda o resumo so no grupo onde foi digitado (pra ver como fica).
export async function commandResumoSemanal({ sock, groupJid }) {
  await sendWeeklySummary(sock, groupJid);
}

// Mensagem automatica das 18h: soma o tempo "perdido" e o ranking completo do
// expediente (ultimas 10h corridas — 8h as 18h), pra cada grupo que o bot participa.
export async function sendEndOfDayMessage(sock) {
  const { date: today } = getBrasiliaNow();
  if (await isBrazilianHoliday(today)) {
    debugLog(`[debug] ${today} e feriado nacional — mensagem de fim de expediente nao enviada.`);
    return;
  }

  const since = Math.floor(Date.now() / 1000) - (EVENING_HOUR - MORNING_HOUR) * 60 * 60;
  const participating = await fetchGroups(sock);

  for (const groupJid of Object.keys(participating)) {
    const counts = getCountsSince(groupJid, since);
    const totalMessages = counts.reduce((sum, c) => sum + c.total, 0);

    const lines = [
      `🔔 Expediente encerrado! Esses são os dados das ${String(MORNING_HOUR).padStart(2, '0')} às ${String(EVENING_HOUR).padStart(2, '0')}. Parabéns Inimigos da Produtividade.`,
    ];
    if (counts.length > 0) {
      lines.push('', '📊 Ranking do dia:', '');
      counts.forEach((c, i) => {
        const percent = Math.round((c.total / totalMessages) * 100);
        lines.push(`${i + 1}. ${formatDisplayName(c.sender_name)}: ${c.total} msgs (${percent}%)`);
      });
      lines.push('', `total de ${totalMessages} Mensagens! 😅`);
    }
    lines.push('', `Para mais informações acesse: ${DASHBOARD_URL}`);

    try {
      await sock.sendMessage(groupJid, { text: lines.join('\n') });
    } catch (err) {
      console.error(`Erro ao enviar mensagem de fim de expediente para ${groupJid}:`, err);
    }

    try {
      await sendWordCloudToGroup(sock, groupJid);
    } catch (err) {
      console.error(`Erro ao enviar a nuvem de palavras para ${groupJid}:`, err);
    }
  }
}

// Ranking semanal: soma o expediente (08h-18h) de segunda a sexta desta semana,
// pulando feriados nacionais, e manda sexta-feira as 18:05.
export async function sendWeeklyRanking(sock) {
  const { date: friday } = getBrasiliaNow(); // so roda as sextas, entao "hoje" e a sexta da semana
  const monday = addDaysBR(friday, -4);

  const weekdays = [];
  for (let i = 0; i < 5; i++) weekdays.push(addDaysBR(monday, i));

  const workingDays = [];
  for (const day of weekdays) {
    if (!(await isBrazilianHoliday(day))) workingDays.push(day);
  }

  const participating = await fetchGroups(sock);

  for (const groupJid of Object.keys(participating)) {
    const merged = new Map();
    for (const day of workingDays) {
      const since = getTimestampBR(day, MORNING_HOUR);
      const until = getTimestampBR(day, EVENING_HOUR);
      for (const c of getCountsBetween(groupJid, since, until)) {
        if (!merged.has(c.sender_jid)) merged.set(c.sender_jid, { sender_name: c.sender_name, total: 0 });
        merged.get(c.sender_jid).total += c.total;
      }
    }

    const counts = [...merged.values()].sort((a, b) => b.total - a.total);
    const totalMessages = counts.reduce((sum, c) => sum + c.total, 0);

    const lines = [
      `📅 *Ranking da semana* (${formatDateBR(monday)} a ${formatDateBR(friday)})`,
      `_Considerando apenas o expediente (${String(MORNING_HOUR).padStart(2, '0')}h às ${String(EVENING_HOUR).padStart(2, '0')}h) de cada dia útil._`,
    ];
    if (counts.length > 0) {
      lines.push('', '📊 Ranking:', '');
      counts.forEach((c, i) => {
        const percent = totalMessages > 0 ? Math.round((c.total / totalMessages) * 100) : 0;
        lines.push(`${i + 1}. ${formatDisplayName(c.sender_name)}: ${c.total} msgs (${percent}%)`);
      });
      lines.push('', `total de ${totalMessages} Mensagens na semana! 📈`);
    }

    try {
      await sock.sendMessage(groupJid, { text: lines.join('\n') });
    } catch (err) {
      console.error(`Erro ao enviar ranking semanal para ${groupJid}:`, err);
    }
  }
}

// Confere se ha mensagens agendadas (scheduled_messages.json) prontas pra
// enviar, e manda pra todos os grupos que o bot participa. Roda a cada minuto
// via cron, e tambem uma vez ao conectar (catch-up se o bot estava desligado
// no horario exato).
export async function sendScheduledMessages(sock) {
  const { date, time } = getBrasiliaNow();
  const due = getDueMessages(date, time);
  if (due.length === 0) return;

  const participating = await fetchGroups(sock);
  const groupJids = Object.keys(participating);

  for (const message of due) {
    for (const groupJid of groupJids) {
      try {
        if (message.text) {
          await sock.sendMessage(groupJid, { text: message.text });
        }
        if (message.audio) {
          const audioPath = path.join(AUDIOS_DIR, message.audio);
          if (fs.existsSync(audioPath)) {
            await sock.sendMessage(groupJid, { audio: fs.readFileSync(audioPath), mimetype: getAudioMimeType(message.audio) });
          } else {
            console.error(`Audio agendado nao encontrado (mensagem ${message.id}): ${audioPath}`);
          }
        }
      } catch (err) {
        console.error(`Erro ao enviar mensagem agendada ${message.id} para ${groupJid}:`, err);
      }
    }
    markScheduledMessageSent(message.id);
  }
}
