// Bothierry Wrapped: o ano em numeros, por pessoa e do grupo. Funcao pura sobre
// os registros de mensagens ({ senderJid, senderName, timestamp, messageDate, text }).
import { extractUrls } from './db.js';
import { buildWordCloud } from './wordcloud.js';
import { formatDisplayName } from './displayNames.js';

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false });
const hourOf = (ts) => Number(hourFmt.format(new Date(ts * 1000))) % 24;
const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const argmax = (arr) => arr.reduce((best, v, i) => (v > arr[best] ? i : best), 0);

// Perfil pela hora em que mais fala.
export function badgeForHour(hour) {
  if (hour < 5) return { title: 'Coruja', desc: 'mais ativo de madrugada' };
  if (hour < 9) return { title: 'Madrugador', desc: 'já chega falando de manhã cedo' };
  if (hour < 18) return { title: 'Expediente', desc: 'fala mais no horário de trabalho' };
  return { title: 'Noturno', desc: 'o grupo acorda à noite com ele' };
}

function longestStreak(dates) {
  const sorted = [...new Set(dates)].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of sorted) {
    run = prev && (new Date(`${d}T12:00:00Z`) - new Date(`${prev}T12:00:00Z`)) / 86400000 === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

/**
 * Calcula o Wrapped do ano. Retorna { year, since, group, people: Map(jid -> stats) }
 * ou null se nao ha mensagens no ano.
 */
export function computeWrapped(records, year) {
  const rows = records.filter((r) => r.messageDate?.startsWith(`${year}-`) && r.senderJid);
  if (rows.length === 0) return null;

  const people = new Map();
  const dayCounts = new Map(); // data -> Map(jid -> n)
  const monthTotals = new Array(12).fill(0);
  const dateTotals = new Map();
  const groupHours = new Array(24).fill(0);
  let links = 0;

  for (const r of rows) {
    const p = people.get(r.senderJid) || { jid: r.senderJid, name: r.senderName, total: 0, hours: new Array(24).fill(0), weekdays: new Array(7).fill(0), dates: [], links: 0, texts: [] };
    p.name = r.senderName;
    p.total += 1;
    const h = hourOf(r.timestamp);
    p.hours[h] += 1;
    groupHours[h] += 1;
    p.weekdays[weekdayOf(r.messageDate)] += 1;
    p.dates.push(r.messageDate);
    if (r.text) {
      p.texts.push(r.text);
      const n = extractUrls(r.text).length;
      p.links += n;
      links += n;
    }
    people.set(r.senderJid, p);
    if (!dayCounts.has(r.messageDate)) dayCounts.set(r.messageDate, new Map());
    const dc = dayCounts.get(r.messageDate);
    dc.set(r.senderJid, (dc.get(r.senderJid) || 0) + 1);
    monthTotals[Number(r.messageDate.slice(5, 7)) - 1] += 1;
    dateTotals.set(r.messageDate, (dateTotals.get(r.messageDate) || 0) + 1);
  }

  // Campeao do dia: quem mais falou em cada data.
  const championDays = new Map();
  for (const dc of dayCounts.values()) {
    const [winner] = [...dc.entries()].sort((a, b) => b[1] - a[1])[0];
    championDays.set(winner, (championDays.get(winner) || 0) + 1);
  }

  const ranking = [...people.values()].sort((a, b) => b.total - a.total);
  const total = rows.length;
  const stats = new Map();
  ranking.forEach((p, i) => {
    const hour = argmax(p.hours);
    stats.set(p.jid, {
      jid: p.jid,
      name: formatDisplayName(p.name),
      total: p.total,
      rank: i + 1,
      of: ranking.length,
      percent: Math.round((p.total / total) * 100),
      peakHour: hour,
      badge: badgeForHour(hour),
      favoriteWeekday: WEEKDAYS[argmax(p.weekdays)],
      streak: longestStreak(p.dates),
      activeDays: new Set(p.dates).size,
      championDays: championDays.get(p.jid) || 0,
      links: p.links,
      topWords: buildWordCloud(p.texts, 3).words.map((w) => w.word),
    });
  });

  const [busiestDate, busiestDateCount] = [...dateTotals.entries()].sort((a, b) => b[1] - a[1])[0];
  const topChampion = [...championDays.entries()].sort((a, b) => b[1] - a[1])[0];
  const allTexts = rows.map((r) => r.text).filter(Boolean);
  const group = {
    year,
    total,
    members: ranking.length,
    activeDays: dayCounts.size,
    top5: ranking.slice(0, 5).map((p) => ({ name: formatDisplayName(p.name), total: p.total })),
    busiestDate,
    busiestDateCount,
    busiestMonth: MONTHS[argmax(monthTotals)],
    peakHour: argmax(groupHours),
    links,
    topWords: buildWordCloud(allTexts, 8).words.map((w) => w.word),
    championName: topChampion ? stats.get(topChampion[0]).name : null,
    championDays: topChampion ? topChampion[1] : 0,
  };
  const since = [...dateTotals.keys()].sort()[0];
  return { year, since, group, people: stats };
}
