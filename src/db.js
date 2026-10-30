import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, '..', 'messages.jsonl');
const ARCHIVE_DIR = path.join(__dirname, '..', 'archive');

// Quantos dias de mensagens ficam "quentes" (em messages.jsonl + memoria).
// Mensagens mais antigas que isso sao movidas pra archive/messages-YYYY-MM.jsonl.
// Reduzido de 30 pra 14 dias — menos mensagens em memoria o tempo todo (numa
// VM com RAM bem apertada). Nao perde nada: dados mais antigos continuam
// acessiveis normalmente via archive/ (getAllRecordsForGroup ja mescla os
// dois), so passam a ser lidos do disco sob demanda em vez de ficar sempre
// carregados no processo.
const HOT_WINDOW_DAYS = 14;

function ensureFile() {
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');
}

function readAll() {
  ensureFile();
  const content = fs.readFileSync(LOG_FILE, 'utf-8');
  if (!content.trim()) return [];
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeAll(records) {
  fs.writeFileSync(LOG_FILE, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
}

// Data (YYYY-MM-DD) de um Date no fuso de Brasilia — usado pra agrupar
// mensagens por "dia", em vez do dia UTC (que muda de madrugada UTC, ou seja,
// as 21h de Brasilia, causando "hoje" errado no fim do dia).
function toDateBR(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date);
}

// Corrige registros antigos gravados com messageDate calculado em UTC (bug ja
// corrigido) — recalcula a partir do timestamp bruto, que sempre foi correto.
// Idempotente: so reescreve o arquivo se algo realmente mudar.
function migrateMessageDates(records) {
  let changed = false;
  for (const r of records) {
    const correctDate = toDateBR(new Date(r.timestamp * 1000));
    if (r.messageDate !== correctDate) {
      r.messageDate = correctDate;
      changed = true;
    }
  }
  if (changed) writeAll(records);
  return records;
}

// Data de corte (YYYY-MM-DD): mensagens com messageDate anterior a essa sao
// consideradas "antigas" e vao pro arquivo. Ex: com HOT_WINDOW_DAYS=7 e hoje
// 05/09, o corte fica 29/08 — mensagens de 29/08 em diante ficam quentes.
function getHotCutoffDate() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - HOT_WINDOW_DAYS);
  return toDateBR(cutoff);
}

// Caminho do arquivo mensal de arquivo (archive/messages-YYYY-MM.jsonl)
// correspondente a data de uma mensagem.
function archiveFilePath(messageDate) {
  return path.join(ARCHIVE_DIR, `messages-${messageDate.slice(0, 7)}.jsonl`);
}

// Acrescenta registros aos arquivos mensais corretos (agrupando por mes,
// ja que um lote pode cruzar a virada do mes).
function appendToArchive(records) {
  if (records.length === 0) return;
  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  const byFile = new Map();
  for (const r of records) {
    const file = archiveFilePath(r.messageDate);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(r);
  }
  for (const [file, recs] of byFile) {
    fs.appendFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
}

// Le e filtra um arquivo mensal de arquivo diretamente do disco (sem passar
// pelo cache em memoria) — usado quando uma consulta pede uma data mais
// antiga que a janela quente.
function readArchiveFile(messageDate) {
  const file = archiveFilePath(messageDate);
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf-8');
  if (!content.trim()) return [];
  return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Retorna TODOS os registros de um grupo, quentes + arquivados, sem filtro de
 * data — usado pelas perguntas de dados (@Bothierry) que precisam olhar o
 * historico inteiro (ex: "quantas vezes fulano ficou no top 3").
 */
export function getAllRecordsForGroup(groupJid) {
  const archived = [];
  if (fs.existsSync(ARCHIVE_DIR)) {
    for (const file of fs.readdirSync(ARCHIVE_DIR)) {
      const content = fs.readFileSync(path.join(ARCHIVE_DIR, file), 'utf-8');
      if (!content.trim()) continue;
      for (const line of content.split('\n')) {
        if (!line) continue;
        const r = JSON.parse(line);
        if (r.groupJid === groupJid) archived.push(r);
      }
    }
  }
  return [...archived, ...cache.filter((r) => r.groupJid === groupJid)];
}

function countBySender(rows) {
  const counts = new Map();
  for (const r of rows) {
    if (!counts.has(r.senderJid)) {
      counts.set(r.senderJid, { sender_jid: r.senderJid, sender_name: r.senderName, total: 0 });
    }
    counts.get(r.senderJid).total += 1;
  }
  return [...counts.values()].sort((a, b) => b.total - a.total);
}

// Cache em memoria de todas as mensagens, carregado uma vez do disco ao importar
// este modulo. Evita reler e reparsear o arquivo inteiro a cada mensagem/consulta;
// e atualizado incrementalmente em logMessage().
const cache = migrateMessageDates(readAll());
archiveOldMessages(); // poda mensagens antigas do arquivo quente logo ao iniciar

/**
 * Move mensagens com mais de HOT_WINDOW_DAYS dias de messages.jsonl (e do
 * cache em memoria) para archive/messages-YYYY-MM.jsonl, mantendo o arquivo
 * "quente" e o uso de memoria pequenos e estaveis com o tempo. Chamada ao
 * iniciar o bot e, de novo, todo dia de madrugada via cron (index.js) — assim
 * o messages.jsonl nao volta a crescer sem limite enquanto o processo roda
 * por meses.
 */
export function archiveOldMessages() {
  const cutoff = getHotCutoffDate();
  const toKeep = [];
  const toArchive = [];
  for (const r of cache) {
    if (r.messageDate < cutoff) toArchive.push(r);
    else toKeep.push(r);
  }
  if (toArchive.length === 0) return { archived: 0 };

  appendToArchive(toArchive);
  writeAll(toKeep);
  cache.length = 0;
  cache.push(...toKeep);
  return { archived: toArchive.length };
}

/**
 * Grava uma mensagem recebida no arquivo de log (uma linha JSON por mensagem).
 * "text" e o conteudo da mensagem (usado pelo !resumo) — pode vir vazio para
 * mensagens sem texto (figurinha, imagem sem legenda, etc).
 */
export function logMessage({ msgId, groupJid, groupName, senderJid, senderName, timestamp, text }) {
  const messageDate = toDateBR(new Date(timestamp * 1000));
  const record = { msgId, groupJid, groupName, senderJid, senderName, timestamp, messageDate, text };
  fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
  cache.push(record);
}

/**
 * Le todos os IDs de mensagem ja gravados no log, para dedupe apos reinicio do bot
 * (o Baileys pode reentregar mensagens recentes ao reconectar).
 */
export function loadSeenMessageIds() {
  return new Set(cache.map((r) => r.msgId).filter(Boolean));
}

/**
 * Retorna a contagem de mensagens por usuario em um grupo, numa data especifica.
 * So enxerga a janela quente (ultimos HOT_WINDOW_DAYS dias) — pra qualquer
 * data, incluindo arquivadas, use getDailyCountsAnyDate.
 */
export function getDailyCounts(groupJid, date) {
  return countBySender(cache.filter((r) => r.groupJid === groupJid && r.messageDate === date));
}

/**
 * Igual a getDailyCounts, mas tambem busca no arquivo (archive/messages-YYYY-MM.jsonl)
 * se a data pedida for mais antiga que a janela quente. Usado pelo report.js,
 * que permite consultar qualquer data passada.
 */
export function getDailyCountsAnyDate(groupJid, date) {
  if (date >= getHotCutoffDate()) return getDailyCounts(groupJid, date);
  const rows = readArchiveFile(date).filter((r) => r.groupJid === groupJid && r.messageDate === date);
  return countBySender(rows);
}

/**
 * Retorna a contagem de mensagens por usuario num grupo desde um timestamp
 * (segundos, unix) — usado pela mensagem automatica das 18h (conta so o
 * expediente, 08h-18h), sem depender de fronteira de dia civil.
 */
export function getCountsSince(groupJid, sinceTimestamp) {
  return countBySender(cache.filter((r) => r.groupJid === groupJid && r.timestamp >= sinceTimestamp));
}

/**
 * Retorna a contagem de mensagens por usuario num grupo entre dois timestamps
 * (segundos, unix) — [sinceTimestamp, untilTimestamp). Usado pelo ranking semanal,
 * que soma varias janelas de expediente (uma por dia util) que nao sao continuas.
 */
export function getCountsBetween(groupJid, sinceTimestamp, untilTimestamp) {
  return countBySender(
    cache.filter((r) => r.groupJid === groupJid && r.timestamp >= sinceTimestamp && r.timestamp < untilTimestamp)
  );
}

/**
 * Acha o JID de um grupo pelo nome (subject) — so olha a janela quente,
 * suficiente pro caso de uso (painel de monitoramento, que so quer o grupo
 * ativo agora). Retorna null se nenhuma mensagem recente desse grupo existir.
 */
export function getGroupJidByName(groupName) {
  const found = cache.find((r) => r.groupName === groupName);
  return found ? found.groupJid : null;
}

/**
 * JID do grupo "principal": o que mais teve mensagens nos ultimos 7 dias (em
 * empate, o de mensagem mais recente). Serve pra painel/tarefas nao dependerem
 * do NOME do grupo, que o pessoal muda com frequencia. Retorna null se nao ha
 * nenhuma mensagem na janela quente.
 */
export function getMainGroupJid() {
  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const stats = new Map(); // groupJid -> { count, last }
  for (const r of cache) {
    if (r.timestamp < since) continue;
    const entry = stats.get(r.groupJid) || { count: 0, last: 0 };
    entry.count += 1;
    entry.last = Math.max(entry.last, r.timestamp);
    stats.set(r.groupJid, entry);
  }
  let best = null;
  for (const [jid, e] of stats) {
    if (!best || e.count > best.count || (e.count === best.count && e.last > best.last)) best = { jid, ...e };
  }
  return best ? best.jid : null;
}

/**
 * Lista os JIDs distintos de quem mandou mensagem num grupo, na janela
 * quente (ultimos HOT_WINDOW_DAYS dias) — usado pra saber de quem buscar
 * foto de perfil (nao faz sentido cachear foto de quem nao fala ha meses).
 */
export function getRecentSenderJids(groupJid) {
  return [...new Set(cache.filter((r) => r.groupJid === groupJid).map((r) => r.senderJid))];
}

function normalizeNameForMatch(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .toLowerCase()
    .trim();
}

/**
 * Acha o JID de uma pessoa pelo nome, comparando (sem acento/maiuscula) com
 * o senderName de quem ja mandou mensagem nesse grupo — usado pra associar
 * fotos de perfil enviadas manualmente (arquivo "Nome Da Pessoa.jpg") ao JID
 * certo. Aceita nome parcial (ex: "Thierry" acha "Thierry Duarte"), desde
 * que bata com um unico sender_name — se bater com mais de um, devolve null
 * pra evitar associar com a pessoa errada.
 */
export function findSenderJidByName(groupJid, name) {
  const target = normalizeNameForMatch(name);
  const matches = new Map(); // senderJid -> senderName (dedupe)
  for (const r of cache) {
    if (r.groupJid !== groupJid) continue;
    const normalized = normalizeNameForMatch(r.senderName);
    if (normalized === target || normalized.includes(target)) {
      matches.set(r.senderJid, r.senderName);
    }
  }
  if (matches.size === 1) return [...matches.keys()][0];
  if (matches.size > 1) {
    // Prefere igualdade exata se houver, pra desempatar nome parcial ambiguo.
    for (const [jid, senderName] of matches) {
      if (normalizeNameForMatch(senderName) === target) return jid;
    }
  }
  return null;
}

/**
 * Retorna as mensagens de texto (nao vazias) de um grupo desde um timestamp
 * (segundos, unix), em ordem cronologica — usado pelo !resumo pra pegar as
 * ultimas 24h corridas, independente de fronteira de dia civil.
 */
export function getMessagesSince(groupJid, sinceTimestamp) {
  return cache
    .filter((r) => r.groupJid === groupJid && r.timestamp >= sinceTimestamp && r.text)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((r) => ({ senderName: r.senderName, timestamp: r.timestamp, text: r.text }));
}

// TLDs reconhecidos pra pegar dominio "nu" (sem protocolo nem "www.", tipo
// "globo.com" ou "pornhub.com") sem disparar em qualquer "palavra.palavra"
// que apareca no meio de uma conversa casual.
const KNOWN_TLDS = 'com(?:\\.br)?|net|org|gov(?:\\.br)?|io|co|app|dev|tv|me|info|biz|edu(?:\\.br)?|br';

/**
 * Extrai as URLs de um texto — com protocolo (http/https), comecando com
 * "www.", ou um dominio "nu" com TLD reconhecido (ex: "globo.com", que o
 * WhatsApp tambem linkifica mesmo sem "www." ou protocolo).
 */
export function extractUrls(text) {
  const pattern = new RegExp(`(https?:\\/\\/\\S+|www\\.\\S+|\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${KNOWN_TLDS})\\b\\/?\\S*)`, 'gi');
  return text.match(pattern) || [];
}

/**
 * Verifica se uma URL exata ja apareceu em alguma mensagem do grupo desde um
 * timestamp (segundos, unix) — usado pelo detector de link repetido.
 */
export function wasUrlSentSince(groupJid, url, sinceTimestamp) {
  return cache.some((r) => {
    if (r.groupJid !== groupJid || r.timestamp < sinceTimestamp || !r.text) return false;
    return extractUrls(r.text).includes(url);
  });
}

function groupsFromRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.groupJid)) {
      groups.set(r.groupJid, { group_jid: r.groupJid, group_name: r.groupName });
    }
  }
  return [...groups.values()];
}

// Nomes dos dias da semana, na ordem que o Intl.DateTimeFormat (weekday
// 'short', fuso Brasilia) devolve pro indice 0-6 usado no heatmap — ja no
// padrao que o front-end do painel espera pra rotular o eixo.
const WEEKDAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/**
 * Tendencia de mensagens por dia, por pessoa, nos ultimos `days` dias
 * (incluindo hoje) — usado pelo grafico de linha "ranking historico" do
 * painel. So traz as `topN` pessoas com mais mensagens no periodo todo, pra
 * nao poluir o grafico com gente que mandou 1 mensagem uma vez.
 */
export function getMessageTrend(groupJid, days, topN = 8) {
  const todayStr = toDateBR(new Date());
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const startDate = dates[0];

  const rows = getAllRecordsForGroup(groupJid).filter((r) => r.messageDate >= startDate);

  // Descobre quem sao as topN pessoas do periodo, pra so essas virarem linha no grafico.
  const totals = new Map();
  for (const r of rows) totals.set(r.senderName, (totals.get(r.senderName) || 0) + 1);
  const topSenders = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([name]) => name);
  const topSet = new Set(topSenders);

  // bySenderByDate[sender][date] = total
  const bySenderByDate = new Map(topSenders.map((name) => [name, Object.fromEntries(dates.map((d) => [d, 0]))]));
  for (const r of rows) {
    if (!topSet.has(r.senderName)) continue;
    bySenderByDate.get(r.senderName)[r.messageDate] += 1;
  }

  return {
    dates,
    series: topSenders.map((name) => ({ name, data: dates.map((d) => bySenderByDate.get(name)[d]) })),
  };
}

/**
 * Heatmap de atividade: quantidade de mensagens por dia-da-semana (0=domingo)
 * x hora do dia (0-23), no fuso de Brasilia — olha o historico inteiro
 * disponivel (quente + arquivado) do grupo, pra revelar o padrao real de
 * horario de pico, nao so o de um dia especifico.
 */
export function getActivityHeatmap(groupJid) {
  const matrix = Array.from({ length: 7 }, () => Array(24).fill(0));
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', hour12: false });

  const weekdayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  for (const r of getAllRecordsForGroup(groupJid)) {
    const parts = fmt.formatToParts(new Date(r.timestamp * 1000));
    const weekday = parts.find((p) => p.type === 'weekday').value;
    let hour = Number(parts.find((p) => p.type === 'hour').value);
    if (hour === 24) hour = 0;
    matrix[weekdayIndex[weekday]][hour] += 1;
  }

  return { weekdayNames: WEEKDAY_NAMES, matrix };
}

/**
 * Pra cada hora (00-23) de um dia especifico, acha quem mais mandou mensagem
 * naquela hora — usado pelo grafico "Mensagens por hora" do painel, pra
 * mostrar a foto/nome de quem dominou cada horario. So olha a data pedida
 * (usa getAllRecordsForGroup pra funcionar tambem em datas arquivadas).
 */
export function getTopSenderPerHour(groupJid, dateStr) {
  const rows = getAllRecordsForGroup(groupJid).filter((r) => r.groupJid === groupJid && r.messageDate === dateStr);

  // countsByHour[hour] = Map(senderJid -> { senderName, count })
  const countsByHour = Array.from({ length: 24 }, () => new Map());
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false });

  for (const r of rows) {
    let hour = Number(fmt.format(new Date(r.timestamp * 1000)));
    if (hour === 24) hour = 0;
    const bucket = countsByHour[hour];
    const entry = bucket.get(r.senderJid) || { senderName: r.senderName, count: 0 };
    entry.count += 1;
    bucket.set(r.senderJid, entry);
  }

  const result = {};
  countsByHour.forEach((bucket, hour) => {
    let top = null;
    for (const [jid, { senderName, count }] of bucket) {
      if (!top || count > top.count) top = { jid, senderName, count };
    }
    result[String(hour).padStart(2, '0')] = top;
  });
  return result;
}

/**
 * Retorna todos os grupos que tiveram mensagens registradas numa data.
 * So enxerga a janela quente — pra qualquer data, incluindo arquivadas, use
 * getGroupsWithMessagesAnyDate.
 */
export function getGroupsWithMessages(date) {
  return groupsFromRows(cache.filter((r) => r.messageDate === date));
}

/**
 * Igual a getGroupsWithMessages, mas tambem busca no arquivo se a data pedida
 * for mais antiga que a janela quente. Usado pelo report.js.
 */
export function getGroupsWithMessagesAnyDate(date) {
  if (date >= getHotCutoffDate()) return getGroupsWithMessages(date);
  return groupsFromRows(readArchiveFile(date).filter((r) => r.messageDate === date));
}

/**
 * Lista todas as pessoas que ja mandaram mensagem no grupo (historico
 * inteiro, quente + arquivado) — usado pela aba Membros do painel. Nome fica
 * com a grafia mais recente vista (pessoas as vezes mudam o nome de exibicao
 * do WhatsApp).
 */
export function getMemberList(groupJid) {
  const allRows = getAllRecordsForGroup(groupJid);
  const today = toDateBR(new Date());
  const bySender = new Map();
  for (const r of allRows) {
    let m = bySender.get(r.senderJid);
    if (!m) {
      m = { jid: r.senderJid, name: r.senderName, total: 0, todayCount: 0, since: r.messageDate };
      bySender.set(r.senderJid, m);
    }
    m.total += 1;
    if (r.messageDate === today) m.todayCount += 1;
    if (r.messageDate < m.since) m.since = r.messageDate;
    m.name = r.senderName;
  }
  return [...bySender.values()];
}

/**
 * Estatisticas detalhadas de UMA pessoa — total, hoje, posicao no ranking de
 * hoje, podio historico (quantas vezes ficou em 1o/2o/3o no "expediente"
 * 08h-18h, mesmo criterio do !ranking/card Ranking), mapa de calor pessoal
 * (dia-da-semana x hora), horario/dia preferido, e tendencia dos ultimos 14
 * dias. Usado pelo modal de detalhes da aba Membros. Retorna null se a
 * pessoa nao tiver nenhuma mensagem registrada.
 */
export function getMemberStats(groupJid, jid) {
  const allRows = getAllRecordsForGroup(groupJid);
  const myRows = allRows.filter((r) => r.senderJid === jid);
  if (myRows.length === 0) return null;

  const name = myRows[myRows.length - 1].senderName;
  const total = myRows.length;
  const since = myRows.reduce((min, r) => (r.messageDate < min ? r.messageDate : min), myRows[0].messageDate);
  const today = toDateBR(new Date());
  const todayCount = myRows.filter((r) => r.messageDate === today).length;

  // Podio: por dia, ranking de quem mais mandou mensagem no expediente
  // (08h-18h) — mesmo criterio usado em outras partes do painel/bot.
  const fmtHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false });
  const byDateSender = new Map(); // date -> Map(jid -> count)
  for (const r of allRows) {
    let hour = Number(fmtHour.format(new Date(r.timestamp * 1000)));
    if (hour === 24) hour = 0;
    if (hour < 8 || hour >= 18) continue;
    if (!byDateSender.has(r.messageDate)) byDateSender.set(r.messageDate, new Map());
    const bucket = byDateSender.get(r.messageDate);
    bucket.set(r.senderJid, (bucket.get(r.senderJid) || 0) + 1);
  }
  let gold = 0;
  let silver = 0;
  let bronze = 0;
  let rankTodayPos = null;
  for (const [date, bucket] of byDateSender) {
    const sorted = [...bucket.entries()].sort((a, b) => b[1] - a[1]);
    const pos = sorted.findIndex(([senderJid]) => senderJid === jid);
    if (pos === 0) gold++;
    else if (pos === 1) silver++;
    else if (pos === 2) bronze++;
    if (date === today && pos !== -1) rankTodayPos = pos + 1;
  }
  const rankToday = rankTodayPos ? `${rankTodayPos}º` : '—';

  // Mapa de calor pessoal: igual getActivityHeatmap, so que filtrado pra essa pessoa.
  const matrix = Array.from({ length: 7 }, () => Array(24).fill(0));
  const fmtFull = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', hour12: false });
  const weekdayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  for (const r of myRows) {
    const parts = fmtFull.formatToParts(new Date(r.timestamp * 1000));
    const weekday = parts.find((p) => p.type === 'weekday').value;
    let hour = Number(parts.find((p) => p.type === 'hour').value);
    if (hour === 24) hour = 0;
    matrix[weekdayIndex[weekday]][hour] += 1;
  }

  // Horario/dia preferido: celula e linha com mais mensagens no mapa de calor.
  let peakHour = 0;
  let peakHourCount = -1;
  const dayTotals = Array(7).fill(0);
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      dayTotals[d] += matrix[d][h];
      if (matrix[d][h] > peakHourCount) {
        peakHourCount = matrix[d][h];
        peakHour = h;
      }
    }
  }
  const peakDayIdx = dayTotals.indexOf(Math.max(...dayTotals));

  // Tendencia: mensagens dessa pessoa nos ultimos 14 dias.
  const trendDates = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - i);
    trendDates.push(d.toISOString().slice(0, 10));
  }
  const trendCounts = Object.fromEntries(trendDates.map((d) => [d, 0]));
  for (const r of myRows) {
    if (r.messageDate in trendCounts) trendCounts[r.messageDate] += 1;
  }

  return {
    jid,
    name,
    total,
    todayCount,
    since,
    rankToday,
    gold,
    silver,
    bronze,
    heatmap: { weekdayNames: WEEKDAY_NAMES, matrix },
    peakHour,
    peakDayIdx,
    peakDayName: WEEKDAY_NAMES[peakDayIdx],
    trend: { dates: trendDates, counts: trendDates.map((d) => trendCounts[d]) },
  };
}

/**
 * Resumo de uma janela de tempo [sinceTs, untilTs) (segundos, unix) de um grupo,
 * comparado com a janela anterior de mesmo tamanho — usado pelo resumo semanal.
 * Retorna null se ninguem falou na janela.
 */
export function getWindowSummary(groupJid, sinceTs, untilTs) {
  const rows = getAllRecordsForGroup(groupJid);
  const inWindow = rows.filter((r) => r.timestamp >= sinceTs && r.timestamp < untilTs);
  if (inWindow.length === 0) return null;
  const prevSince = sinceTs - (untilTs - sinceTs);
  const prevTotal = rows.filter((r) => r.timestamp >= prevSince && r.timestamp < sinceTs).length;

  const bySender = new Map();
  const byHour = new Array(24).fill(0);
  const byDate = new Map();
  const urlCounts = new Map();
  let linkMessages = 0;
  const fmtHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false });

  for (const r of inWindow) {
    const s = bySender.get(r.senderJid) || { jid: r.senderJid, name: r.senderName, total: 0 };
    s.total += 1;
    s.name = r.senderName;
    bySender.set(r.senderJid, s);
    byHour[Number(fmtHour.format(new Date(r.timestamp * 1000))) % 24] += 1;
    byDate.set(r.messageDate, (byDate.get(r.messageDate) || 0) + 1);
    const urls = r.text ? extractUrls(r.text) : [];
    if (urls.length > 0) linkMessages += 1;
    for (const u of new Set(urls)) urlCounts.set(u, (urlCounts.get(u) || 0) + 1);
  }

  const ranking = [...bySender.values()].sort((a, b) => b.total - a.total);
  const peakHour = byHour.indexOf(Math.max(...byHour));
  const [peakDate] = [...byDate.entries()].sort((a, b) => b[1] - a[1])[0];
  const peakDayName = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'long' }).format(new Date(peakDate + 'T12:00:00Z'));
  const topLinkRepeats = Math.max(0, ...urlCounts.values());

  return { total: inWindow.length, prevTotal, ranking, peakHour, peakDayName, linkMessages, topLinkRepeats };
}
