// Dados da aba "Perfis": a pagina de UM membro — numeros do ano (os mesmos do
// Bothierry Wrapped), total de sempre, historico dos ultimos 60 dias, mensagens
// por mes, mensagens por hora e as palavras que mais usa.
import { computeWrapped } from './wrapped.js';
import { buildWordCloud } from './wordcloud.js';

const brDate = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ts * 1000));
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false });

/** Perfil de `jid` a partir dos registros do grupo, ou null se a pessoa nao tem mensagens. */
export function buildProfile(records, jid, now = new Date()) {
  const mine = records.filter((r) => r.senderJid === jid);
  if (mine.length === 0) return null;

  const nowSec = Math.floor(now.getTime() / 1000);
  const year = Number(brDate(nowSec).slice(0, 4));
  const wrapped = computeWrapped(records, year);
  const stats = wrapped?.people.get(jid) || null; // null se so tem mensagens de outros anos

  const perDay = new Map();
  const perMonth = new Array(12).fill(0);
  const perHour = new Array(24).fill(0);
  let busiestDate = null;
  for (const r of mine) {
    perDay.set(r.messageDate, (perDay.get(r.messageDate) || 0) + 1);
    if (r.messageDate.startsWith(`${year}-`)) perMonth[Number(r.messageDate.slice(5, 7)) - 1] += 1;
    perHour[Number(hourFmt.format(new Date(r.timestamp * 1000))) % 24] += 1;
  }
  for (const [d, n] of perDay) if (!busiestDate || n > perDay.get(busiestDate)) busiestDate = d;

  const daily = [];
  for (let i = 59; i >= 0; i--) {
    const d = brDate(nowSec - i * 86400);
    daily.push({ date: d, count: perDay.get(d) || 0 });
  }

  return {
    year,
    stats,
    totalAllTime: mine.length,
    firstDate: [...perDay.keys()].sort()[0],
    busiestDate,
    busiestCount: perDay.get(busiestDate),
    daily,
    perMonth,
    perHour,
    words: buildWordCloud(mine.map((r) => r.text).filter(Boolean), 40).words,
  };
}
