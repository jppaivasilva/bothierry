// Infraestrutura compartilhada pelos modulos do bot: constantes, data/hora de Brasilia, cliente OpenAI, lista de grupos, feriados e o estado do socket.

import path from 'path';
import { fileURLToPath } from 'url';
import { trackOpenAIUsage } from '../usage.js';
import OpenAI from 'openai';
import fs from 'fs';
import { getMainGroupJid } from '../db.js';


// Raiz do projeto (as pastas de dados — audios/, regras/, assets/ — ficam nela).
export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Socket do WhatsApp atual (trocado a cada reconexao); as tarefas agendadas usam botState.sock.
export const botState = { sock: null };

// `sharp` (processamento de imagem) carrega uma biblioteca nativa pesada
// (libvips) na memoria assim que e importada — mas so e usada em comandos
// raros (!figurinha, !fotogrupo, !fotobot, troca de tema da foto do bot).
// Carregar sob demanda, so na primeira vez que algum desses rodar, evita
// pagar esse custo de memoria o tempo todo numa VM com RAM apertada.
let sharpModule;

export async function getSharp() {
  if (!sharpModule) sharpModule = (await import('sharp')).default;
  return sharpModule;
}

// Fuso usado por todos os agendamentos do bot (aniversario, bom-dia, fim de expediente).
export const TIMEZONE = 'America/Sao_Paulo';

// URL publica do painel (VM na Oracle Cloud) — usada nos avisos automaticos
// que convidam o pessoal a ver mais detalhes no painel.
export const DASHBOARD_URL = 'https://painel.bothierry.com.br';

// Horario em que o aviso de aniversario e checado todo dia.
export const BIRTHDAY_CHECK_HOUR = 9;

// Horario em que mensagens com mais de 7 dias (HOT_WINDOW_DAYS, em db.js) sao
// movidas do messages.jsonl pra archive/ — de madrugada, baixo movimento.
export const ARCHIVE_HOUR = 3;

// Horarios das mensagens automaticas de bom-dia e fim de expediente.
export const MORNING_HOUR = 8;

export const EVENING_HOUR = 18;

// Pasta de audios: usada pelo detector de link repetido, pelas mensagens
// agendadas e pelos comandos !audios / !<nome-do-audio>.
export const AUDIOS_DIR = path.join(ROOT, 'audios');

export const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.ogg'];

export const LINK_REPEAT_AUDIO = path.join(AUDIOS_DIR, 'repetido.mp3');

// Texto fixo mostrado pelo !regulamento.
export const REGULAMENTO_FILE = path.join(ROOT, 'regulamento.txt');

// Texto fixo mostrado pelo !megasena.
export const MEGASENA_FILE = path.join(ROOT, 'megasena.txt');

// Modelo da OpenAI usado pelo !resumo, e limite de tamanho do transcript
// enviado (protecao simples contra prompts gigantes/caros em grupos muito ativos).
export const OPENAI_MODEL = 'gpt-4o-mini';

export const MAX_TRANSCRIPT_CHARS = 12000;

// Logs verbosos (uma linha por mensagem recebida, incluindo o texto) sao uteis
// para depurar mas expoem conteudo do grupo no terminal — desligados por padrao.
// Ative com DEBUG=1 npm start
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

export function debugLog(...args) {
  if (DEBUG) console.log(...args);
}

export const groupNameCache = new Map();

export const sentByBot = new Set();

export async function getGroupName(sock, groupJid) {
  if (groupNameCache.has(groupJid)) return groupNameCache.get(groupJid);
  try {
    const meta = await sock.groupMetadata(groupJid);
    groupNameCache.set(groupJid, meta.subject);
    return meta.subject;
  } catch {
    return groupJid;
  }
}

// Remove o sufixo de dispositivo (:12) que o WhatsApp as vezes adiciona ao proprio JID
export function normalizeJid(jid) {
  return jid ? jid.replace(/:\d+@/, '@') : jid;
}

// Converte uma data ISO (YYYY-MM-DD, usada internamente para gravar/consultar) para
// o formato de exibicao DD-MM-YYYY.
export function formatDateBR(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}-${month}-${year}`;
}

// Converte "DD/MM/AA", "DD/MM/AAAA" ou com "-" no lugar de "/" pra ISO (YYYY-MM-DD).
// Retorna null se nao reconhecer o formato.
export function parseDateBR(str) {
  const match = str.trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!match) return null;
  let [, day, month, year] = match;
  if (year.length === 2) year = `20${year}`;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

export function stripAccents(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Cliente OpenAI criado sob demanda (so quando o !resumo e chamado), pra nao
// falhar na inicializacao do bot se OPENAI_API_KEY ainda nao estiver configurada.
let openaiClient = null;

export function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!openaiClient) openaiClient = trackOpenAIUsage(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
  return openaiClient;
}

const IMAGE_ASSET_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

// Acha assets/<baseName>.<ext>, testando as extensoes aceitas — assim nao
// importa em que formato a imagem foi salva.
export function findImageAsset(baseName) {
  for (const ext of IMAGE_ASSET_EXTENSIONS) {
    const candidate = path.join(ROOT, 'assets', `${baseName}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Lista os grupos do bot. O WhatsApp as vezes responde "rate-overlimit" a essa
// consulta (foi o que derrubou a mensagem de fim de expediente de 03/11), entao:
// tenta de novo ate 3 vezes com espera crescente (30s, 60s, 90s) e guarda o
// resultado por 2 min, pra varias tarefas seguidas nao baterem na API de novo.
const GROUPS_CACHE_MS = 2 * 60 * 1000;

let groupsCache = { at: 0, value: null };

export async function fetchGroups(sock) {
  if (groupsCache.value && Date.now() - groupsCache.at < GROUPS_CACHE_MS) return groupsCache.value;
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await sock.groupFetchAllParticipating();
      groupsCache = { at: Date.now(), value };
      return value;
    } catch (err) {
      if (!/rate-overlimit/i.test(String(err?.message ?? err)) || attempt >= 3) throw err;
      console.error(`[grupos] rate-overlimit ao listar grupos, tentando de novo em ${30 * (attempt + 1)}s`);
      await new Promise((resolve) => setTimeout(resolve, 30000 * (attempt + 1)));
    }
  }
}

// Acha o JID de um grupo pelo nome (subject) — Baileys so indexa grupos por
// JID, entao e preciso listar todos os grupos que o bot participa e comparar.
// Acha o grupo "principal" do bot SEM depender do nome (que muda com frequencia):
// se o bot esta em um grupo so, e ele; se em varios, o mais ativo nos ultimos 7 dias.
export async function findMainGroupJid(sock) {
  const participating = await fetchGroups(sock);
  const jids = Object.keys(participating);
  if (jids.length === 1) return jids[0];
  const active = getMainGroupJid();
  return active && jids.includes(active) ? active : null;
}

// Converte uma data (YYYY-MM-DD, no fuso de Brasilia) + hora local num timestamp
// unix. Brasil nao tem horario de verao desde 2019, entao o offset fixo -03:00 e seguro.
export function getTimestampBR(dateStr, hour) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day, hour + 3, 0, 0) / 1000);
}

// Soma um numero de dias a uma data (YYYY-MM-DD), sem depender de fuso (usa meio-dia UTC).
export function addDaysBR(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Data/hora atuais no fuso de Brasilia, no formato usado por scheduled_messages.json.
export function getBrasiliaNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

// Feriados nacionais brasileiros via BrasilAPI (gratis, sem chave). Cacheado
// por ano pra nao bater na API toda vez.
const holidaysCache = new Map();

async function getHolidaysForYear(year) {
  if (holidaysCache.has(year)) return holidaysCache.get(year);
  try {
    const res = await fetch(`https://brasilapi.com.br/api/feriados/v1/${year}`);
    if (!res.ok) throw new Error(`status HTTP ${res.status}`);
    const data = await res.json();
    const holidays = new Map(data.map((h) => [h.date, h.name]));
    holidaysCache.set(year, holidays);
    return holidays;
  } catch (err) {
    console.error(`Erro ao buscar feriados de ${year}:`, err);
    return new Map(); // falha segura: nao bloqueia o envio se a API estiver fora
  }
}

// Retorna o nome do feriado nacional numa data, ou null se nao for feriado.
export async function getHolidayName(dateStr) {
  const holidays = await getHolidaysForYear(dateStr.slice(0, 4));
  return holidays.get(dateStr) || null;
}

export async function isBrazilianHoliday(dateStr) {
  return (await getHolidayName(dateStr)) !== null;
}
