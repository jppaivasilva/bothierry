import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const METRICS_FILE = path.join(__dirname, '..', 'metrics.jsonl');

// Quantos dias de eventos manter no arquivo — mais que suficiente pra
// diagnosticar problemas de conexao/uso, sem crescer pra sempre.
const METRICS_RETENTION_DAYS = 30;

// Estado em memoria do processo atual — usado pra responder "esta conectado
// agora?" sem precisar reler o arquivo inteiro a cada requisicao do painel.
let currentStatus = 'starting'; // 'connected' | 'disconnected' | 'starting'
let lastStatusChangeAt = Date.now();
const processStartedAt = Date.now();

// Contador de mensagens do minuto corrente — flusha pro arquivo a cada
// minuto como um unico evento agregado, em vez de uma linha por mensagem
// (que geraria milhares de linhas/dia sem necessidade).
let messageBucket = 0;
let messageBucketStart = Date.now();

function appendEvent(event) {
  fs.appendFileSync(METRICS_FILE, JSON.stringify({ ts: Date.now(), ...event }) + '\n');
}

/**
 * Registra uma mudanca de estado da conexao com o WhatsApp (conectado,
 * desconectado, reconexao agendada). Eventos raros — grava na hora.
 */
export function recordConnectionEvent(status, extra = {}) {
  currentStatus = status;
  lastStatusChangeAt = Date.now();
  appendEvent({ type: 'connection', status, ...extra });
}

/**
 * Conta uma mensagem recebida de verdade (nao do proprio bot). So acumula em
 * memoria — flushBucketIfNeeded() decide quando gravar no arquivo.
 */
export function recordMessage() {
  flushBucketIfNeeded();
  messageBucket++;
}

function flushBucketIfNeeded() {
  const now = Date.now();
  if (now - messageBucketStart >= 60000) {
    if (messageBucket > 0) {
      appendEvent({ type: 'messages', count: messageBucket, windowMs: now - messageBucketStart });
    }
    messageBucket = 0;
    messageBucketStart = now;
  }
}

/**
 * Registra o uso de um comando (!ranking, !figurinha, etc) — usado pro painel
 * mostrar o que o pessoal mais usa.
 */
export function recordCommandUsage(commandName) {
  appendEvent({ type: 'command', name: commandName });
}

/**
 * Registra que uma tarefa agendada (cron) rodou — usado pro painel mostrar
 * quando cada automacao rodou pela ultima vez. So as tarefas pouco frequentes
 * (nao a checagem de mensagens agendadas, que roda todo minuto).
 */
export function recordCronRun(cronName) {
  appendEvent({ type: 'cron', name: cronName });
}

// Mantem so os ultimos N erros em memoria pro painel — nao precisa persistir
// entre reinicios, os logs do PM2 ja guardam o historico completo.
const MAX_RECENT_ERRORS = 50;
const recentErrors = [];

/**
 * Registra uma mensagem de erro pro painel mostrar. Chamado automaticamente
 * pelo wrapper de console.error configurado em index.js — nao precisa chamar
 * isso manualmente em cada catch.
 */
export function recordError(message) {
  recentErrors.push({ ts: Date.now(), message: String(message).slice(0, 500) });
  if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.shift();
}

/**
 * Remove do arquivo eventos mais antigos que METRICS_RETENTION_DAYS —
 * chamada 1x por dia via cron, igual o arquivamento de mensagens.
 */
export function pruneOldMetrics() {
  if (!fs.existsSync(METRICS_FILE)) return;
  const cutoff = Date.now() - METRICS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const lines = fs.readFileSync(METRICS_FILE, 'utf-8').split('\n').filter(Boolean);
  const kept = lines.filter((line) => {
    try {
      return JSON.parse(line).ts >= cutoff;
    } catch {
      return false;
    }
  });
  if (kept.length !== lines.length) {
    fs.writeFileSync(METRICS_FILE, kept.join('\n') + (kept.length ? '\n' : ''));
  }
}

function readEvents() {
  if (!fs.existsSync(METRICS_FILE)) return [];
  return fs
    .readFileSync(METRICS_FILE, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Mensagens por hora (00h-23h) de UM dia especifico, no fuso de Brasilia —
 * usado pelo filtro de data do grafico no painel. Olha o historico inteiro
 * guardado (ate METRICS_RETENTION_DAYS dias), nao so as ultimas 24h.
 */
export function getMessagesPerHourForDate(dateStr) {
  const events = readEvents();
  const hours = Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h).padStart(2, '0'), 0]));

  for (const e of events) {
    if (e.type !== 'messages') continue;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(new Date(e.ts));
    const get = (type) => parts.find((p) => p.type === type).value;
    const eventDate = `${get('year')}-${get('month')}-${get('day')}`;
    if (eventDate !== dateStr) continue;
    const hourKey = get('hour') === '24' ? '00' : get('hour');
    hours[hourKey] += e.count;
  }

  return hours;
}

/**
 * Uso de recursos da maquina (VM) onde o bot roda — CPU, memoria e disco.
 * So funciona em Linux/macOS (usa `df`, que nao existe no Windows); se o
 * comando falhar, o disco vem null e o resto do painel segue funcionando.
 */
export function getSystemStats() {
  const cpuCount = os.cpus().length;
  const [load1, load5, load15] = os.loadavg();

  const totalMemBytes = os.totalmem();
  const freeMemBytes = os.freemem();
  const usedMemBytes = totalMemBytes - freeMemBytes;

  let disk = null;
  try {
    const output = execSync('df -B1 --output=size,used,avail,pcent /', { encoding: 'utf-8' });
    const [, dataLine] = output.trim().split('\n');
    const [size, used, avail] = dataLine.trim().split(/\s+/).map(Number);
    disk = {
      totalGb: Math.round(size / 1024 / 1024 / 1024),
      usedGb: Math.round(used / 1024 / 1024 / 1024),
      availGb: Math.round(avail / 1024 / 1024 / 1024),
      usedPercent: Math.round((used / size) * 100),
    };
  } catch (err) {
    console.error('Erro ao ler uso de disco (df):', err.message);
  }

  return {
    cpu: {
      cores: cpuCount,
      loadAvg: { '1min': load1, '5min': load5, '15min': load15 },
      // Carga relativa ao numero de nucleos, como um "% de uso" aproximado —
      // load average nao e uma medida instantanea de CPU, mas e a metrica
      // nativa mais barata de se obter sem ficar lendo /proc/stat em loop.
      usedPercent: Math.min(Math.round((load1 / cpuCount) * 100), 999),
    },
    memory: {
      totalMb: Math.round(totalMemBytes / 1024 / 1024),
      usedMb: Math.round(usedMemBytes / 1024 / 1024),
      freeMb: Math.round(freeMemBytes / 1024 / 1024),
      usedPercent: Math.round((usedMemBytes / totalMemBytes) * 100),
    },
    disk,
  };
}

/**
 * Grava um snapshot do uso de CPU/memoria/disco no historico — chamada por
 * um cron periodico (index.js), nao a cada request, pra nao inflar o arquivo
 * de metricas. So guarda os percentuais (nao o detalhe todo), suficiente pro
 * grafico de tendencia do painel.
 */
export function recordSystemStats() {
  const stats = getSystemStats();
  appendEvent({
    type: 'system',
    cpuPercent: stats.cpu.usedPercent,
    memPercent: stats.memory.usedPercent,
    diskPercent: stats.disk?.usedPercent ?? null,
  });
}

/**
 * Historico de uso de CPU/memoria/disco nas ultimas `hours` horas — usado
 * pelo grafico de tendencia da aba "Servidor" do painel.
 */
export function getSystemStatsHistory(hours = 24) {
  const since = Date.now() - hours * 60 * 60 * 1000;
  return readEvents()
    .filter((e) => e.type === 'system' && e.ts >= since)
    .map((e) => ({ ts: e.ts, cpuPercent: e.cpuPercent, memPercent: e.memPercent, diskPercent: e.diskPercent }));
}

/**
 * Monta os dados que o painel HTML consome: status atual, uptime nas
 * ultimas 24h, timeline de conexao, mensagens por hora, e eventos recentes.
 */
export function getDashboardData() {
  flushBucketIfNeeded();
  const events = readEvents();
  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const recent = events.filter((e) => e.ts >= since24h);

  const connectionEvents = recent.filter((e) => e.type === 'connection');
  const disconnects = connectionEvents.filter((e) => e.status === 'disconnected');

  // Uptime aproximado: soma o tempo entre cada "connected" e o proximo
  // "disconnected" (ou agora, se ainda estiver conectado), dentro da janela.
  let connectedMs = 0;
  let openSince = null;
  for (const e of connectionEvents.sort((a, b) => a.ts - b.ts)) {
    if (e.status === 'connected') openSince = e.ts;
    else if (e.status === 'disconnected' && openSince) {
      connectedMs += e.ts - openSince;
      openSince = null;
    }
  }
  if (openSince) connectedMs += Date.now() - openSince;
  else if (currentStatus === 'connected') connectedMs += Date.now() - Math.max(lastStatusChangeAt, since24h);
  const windowMs = Date.now() - since24h;
  const uptimePercent = windowMs > 0 ? Math.min(100, Math.round((connectedMs / windowMs) * 100)) : 100;

  const messageEvents = recent.filter((e) => e.type === 'messages');
  const messagesPerHour = {};
  for (const e of messageEvents) {
    const hourKey = new Date(e.ts).toISOString().slice(0, 13);
    messagesPerHour[hourKey] = (messagesPerHour[hourKey] || 0) + e.count;
  }

  const commandCounts = {};
  for (const e of recent.filter((e) => e.type === 'command')) {
    commandCounts[e.name] = (commandCounts[e.name] || 0) + 1;
  }
  const topCommands = Object.entries(commandCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  // Ultima execucao de cada cron nomeado (olhando todo o historico salvo, nao
  // so 24h, ja que uma tarefa semanal rodou faz mais de 1 dia sem ser problema).
  const cronLastRuns = {};
  for (const e of events.filter((e) => e.type === 'cron')) {
    if (!cronLastRuns[e.name] || e.ts > cronLastRuns[e.name]) cronLastRuns[e.name] = e.ts;
  }

  const mem = process.memoryUsage();

  return {
    currentStatus,
    lastStatusChangeAt,
    processStartedAt,
    uptimePercent,
    disconnectsLast24h: disconnects.length,
    messagesLastHour: messageEvents.filter((e) => e.ts >= Date.now() - 3600000).reduce((s, e) => s + e.count, 0),
    messagesPerHour,
    topCommands,
    cronLastRuns,
    recentErrors: [...recentErrors].reverse(),
    memory: { rssMb: Math.round(mem.rss / 1024 / 1024), heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024) },
    recentEvents: recent
      .filter((e) => e.type === 'connection')
      .slice(-30)
      .reverse(),
  };
}
