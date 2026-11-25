// Consumo da OpenAI: cada chamada feita pelo bot (chat, transcricao, imagem) e
// registrada em openai_usage.jsonl (so na VM) com os tokens e um custo ESTIMADO
// a partir da tabela de precos abaixo. A aba "Consumo" do painel (so root) le
// esse arquivo. O valor oficial e o do painel da OpenAI — isto e uma estimativa.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USAGE_FILE = path.join(__dirname, '..', 'openai_usage.jsonl');

// USD por 1 milhao de tokens (entrada, entrada em cache, saida). Modelo sem
// preco aqui aparece no painel com os tokens, mas sem valor. Confira os precos
// em https://openai.com/api/pricing e ajuste quando mudarem.
const TOKEN_PRICES = {
  'gpt-4o-mini': { in: 0.15, cachedIn: 0.075, out: 0.6 },
};
// Modelos de imagem cobram por tipo de token (valores estimados).
const IMAGE_PRICES = {
  'gpt-image-1': { textIn: 5, imageIn: 10, out: 40 },
  'gpt-image-1.5': { textIn: 5, imageIn: 8, out: 32 },
};
const WHISPER_USD_PER_MINUTE = 0.006;

// Trava de gasto: passou do limite do MES (US$, estimado, mes de calendario no
// fuso de Brasilia), as chamadas de IA sao recusadas ate o dia 1o (o bot segue
// funcionando sem IA). Mude o limite com AI_MONTHLY_BUDGET_USD no .env; 0 desliga.
export const MONTHLY_BUDGET_USD = process.env.AI_MONTHLY_BUDGET_USD !== undefined && process.env.AI_MONTHLY_BUDGET_USD !== '' ? Number(process.env.AI_MONTHLY_BUDGET_USD) : 10;

// Funcao que fez a chamada (lida da pilha de execucao) -> nome mostrado no painel.
const FEATURES = {
  answerDataQuestion: 'Perguntas ao bot',
  runAgent: 'Perguntas ao bot',
  isInsultToBot: 'Detector de insulto',
  isIphoneDepreciative: 'Regra do iPhone',
  commandResumo: 'Resumo (!resumo)',
  commandTranscrever: 'Transcrição (!transcrever)',
  editBotPhoto: 'Foto do grupo/bot (imagem)',
  pickMostImpactfulHeadline: 'Foto do grupo (escolha da notícia)',
};

function featureFromStack() {
  const stack = new Error().stack || '';
  for (const [fn, label] of Object.entries(FEATURES)) {
    if (new RegExp(`\\b${fn}\\b`).test(stack)) return label;
  }
  return 'Outros';
}

// A API devolve o modelo com data (gpt-4o-mini-2024-07-18); a tabela de precos usa o nome sem a data.
const baseModel = (model) => String(model).replace(/-\d{4}-\d{2}-\d{2}$/, '');

/** Custo estimado (US$) de uma chamada, ou null se o modelo nao tem preco cadastrado. Usado tambem pelo agente pra limitar o gasto por pergunta. */
export function estimateCostUsd(rawModel, usage) {
  return costOf(baseModel(rawModel), usage);
}

function costOf(model, usage) {
  const t = TOKEN_PRICES[model];
  if (t && usage.inTok != null) {
    const cached = usage.cachedInTok || 0;
    return ((usage.inTok - cached) * t.in + cached * t.cachedIn + (usage.outTok || 0) * t.out) / 1e6;
  }
  const img = IMAGE_PRICES[model];
  if (img) return ((usage.textInTok || 0) * img.textIn + (usage.imageInTok || 0) * img.imageIn + (usage.outTok || 0) * img.out) / 1e6;
  if (model === 'whisper-1' && usage.seconds != null) return (usage.seconds / 60) * WHISPER_USD_PER_MINUTE;
  return null; // sem preco cadastrado
}

// Gasto do mes corrente, guardado em memoria (lido do arquivo na primeira vez do mes).
const month = { key: null, cost: 0, warned: false };
function syncMonth() {
  const key = brDate(Math.floor(Date.now() / 1000)).slice(0, 7); // AAAA-MM
  if (month.key !== key) {
    month.key = key;
    month.warned = false;
    month.cost = readEntries().filter((e) => brDate(e.ts).startsWith(key)).reduce((t, e) => t + (e.costUsd || 0), 0);
  }
}

/** Limite mensal de IA atingido? (so olha o gasto estimado do mes corrente) */
export function isBudgetExceeded() {
  if (!(MONTHLY_BUDGET_USD > 0)) return false;
  syncMonth();
  return month.cost >= MONTHLY_BUDGET_USD;
}

/** { limitUsd, usedUsd, exceeded, period, resetsOn } do mes corrente — pro painel. */
export function getBudgetStatus() {
  syncMonth();
  const [y, m] = month.key.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { limitUsd: MONTHLY_BUDGET_USD, usedUsd: month.cost, exceeded: MONTHLY_BUDGET_USD > 0 && month.cost >= MONTHLY_BUDGET_USD, period: month.key, resetsOn: next };
}

function record(feature, model, usage) {
  try {
    const entry = { ts: Math.floor(Date.now() / 1000), feature, model, ...usage, costUsd: costOf(model, usage) };
    fs.appendFileSync(USAGE_FILE, JSON.stringify(entry) + '\n');
    syncMonth();
    month.cost += entry.costUsd || 0;
  } catch (err) {
    console.error('Erro ao registrar consumo da OpenAI:', err);
  }
}

// Troca o metodo por uma versao que chama o original e registra o consumo (nunca atrapalha a chamada).
function wrap(owner, method, toUsage) {
  const original = owner[method].bind(owner);
  owner[method] = async (...args) => {
    const feature = featureFromStack(); // le a pilha ANTES do await, quando a funcao chamadora ainda esta nela
    if (isBudgetExceeded()) {
      if (!month.warned) {
        month.warned = true;
        console.error(`[IA] Limite mensal de gasto atingido (US$ ${MONTHLY_BUDGET_USD.toFixed(2)}): chamadas de IA pausadas ate o dia 1o. Ajuste AI_MONTHLY_BUDGET_USD no .env se quiser.`);
      }
      const err = new Error('limite mensal de gasto da IA atingido');
      err.code = 'AI_BUDGET_EXCEEDED';
      throw err;
    }
    const result = await original(...args);
    try {
      const u = toUsage(result, args[0]);
      if (u) record(feature, baseModel(result?.model || args[0]?.model || 'desconhecido'), u);
    } catch {
      // registrar consumo e opcional
    }
    return result;
  };
}

/** Faz o cliente da OpenAI registrar o consumo de cada chamada. Devolve o proprio cliente. */
export function trackOpenAIUsage(client) {
  wrap(client.chat.completions, 'create', (res) =>
    res?.usage ? { inTok: res.usage.prompt_tokens, cachedInTok: res.usage.prompt_tokens_details?.cached_tokens || 0, outTok: res.usage.completion_tokens } : null,
  );
  wrap(client.audio.transcriptions, 'create', (res, req) => ({
    seconds: res?.usage?.seconds ?? (req?.file?.size ? req.file.size / 4000 : null), // sem duracao na resposta: estima pelo tamanho do arquivo
  }));
  for (const method of ['edit', 'generate']) {
    wrap(client.images, method, (res) =>
      res?.usage
        ? { inTok: res.usage.input_tokens, textInTok: res.usage.input_tokens_details?.text_tokens || 0, imageInTok: res.usage.input_tokens_details?.image_tokens || 0, outTok: res.usage.output_tokens }
        : { inTok: null },
    );
  }
  return client;
}

function readEntries() {
  try {
    return fs
      .readFileSync(USAGE_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const brDate = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ts * 1000));

function sum(entries) {
  let calls = 0, inTok = 0, outTok = 0, costUsd = 0, unpriced = 0;
  for (const e of entries) {
    calls += 1;
    inTok += e.inTok || 0;
    outTok += e.outTok || 0;
    if (e.costUsd == null) unpriced += 1;
    else costUsd += e.costUsd;
  }
  return { calls, inTok, outTok, costUsd, unpriced };
}

function groupBy(entries, key) {
  const map = new Map();
  for (const e of entries) {
    const k = key(e);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  return [...map.entries()].map(([name, list]) => ({ name, ...sum(list) })).sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}

/** Resumo pro painel: totais (hoje, 7 dias, 30 dias, tudo), por funcao e por modelo (30 dias) e custo por dia (30 dias). */
export function getUsageSummary(now = new Date()) {
  const entries = readEntries();
  const nowSec = Math.floor(now.getTime() / 1000);
  const today = brDate(nowSec);
  const within = (days) => entries.filter((e) => e.ts >= nowSec - days * 86400);
  const last30 = within(30);

  const dailyMap = new Map();
  for (const e of last30) dailyMap.set(brDate(e.ts), (dailyMap.get(brDate(e.ts)) || 0) + (e.costUsd || 0));
  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const d = brDate(nowSec - i * 86400);
    daily.push({ date: d, costUsd: dailyMap.get(d) || 0 });
  }

  return {
    budget: getBudgetStatus(),
    since: entries[0] ? brDate(entries[0].ts) : null,
    totals: {
      today: sum(entries.filter((e) => brDate(e.ts) === today)),
      week: sum(within(7)),
      month: sum(last30),
      calendarMonth: sum(entries.filter((e) => brDate(e.ts).startsWith(today.slice(0, 7)))),
      all: sum(entries),
    },
    byFeature: groupBy(last30, (e) => e.feature),
    byModel: groupBy(last30, (e) => e.model),
    daily,
  };
}
