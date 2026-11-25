// Nucleo do agente de IA: em vez de "uma funcao e pronto", a IA pode encadear
// varias consultas (funcoes) — olhar o resultado de uma, decidir a proxima — ate
// ter o que precisa pra responder. Protecoes: maximo de passos, teto de gasto
// por pergunta, consulta repetida reaproveitada (evita laco), tempo limite por
// funcao. Cada pergunta deixa um "traco" (passos, funcoes, custo) em
// agent_traces.jsonl, que a aba "Agente" do painel (so root) mostra.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { estimateCostUsd } from './usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACE_FILE = process.env.AGENT_TRACES_FILE || path.join(__dirname, '..', 'agent_traces.jsonl');

export const AGENT_LIMITS = {
  maxSteps: 5, // rodadas de funcoes antes de ser obrigado a responder
  maxCostUsd: 0.05, // gasto estimado por pergunta; passou, responde com o que tem
  toolTimeoutMs: 20_000,
  maxToolResultChars: 12_000,
};

const clip = (v, n) => (v == null ? v : String(v).length > n ? String(v).slice(0, n) + '…' : String(v));

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('a consulta demorou demais')), ms)))]).finally(() => clearTimeout(timer));
}

/**
 * Roda o laco do agente. `callTool(name, args)` executa uma funcao e devolve o resultado.
 * Devolve { answer, outcome, steps, costUsd } — outcome: ok | max_steps | cost_cap | empty.
 * Erros da IA (ex.: limite mensal) sobem pro chamador, mas o traco e gravado antes.
 */
export async function runAgent({ client, model, messages, tools, callTool, temperature = 0.4, maxTokens = 3000, meta = {}, limits = {} }) {
  const lim = { ...AGENT_LIMITS, ...limits };
  const startedAt = Date.now();
  const trace = { ts: Math.floor(startedAt / 1000), asker: meta.asker || null, question: clip(meta.question, 300), image: meta.image || undefined, outcome: 'ok', steps: [], costUsd: 0, totalMs: 0, answer: null };
  const seen = new Map(); // consulta repetida (mesma funcao+argumentos) reaproveita o resultado
  let costUsd = 0;
  let forced = null;

  try {
    for (let n = 1; n <= lim.maxSteps + 1; n++) {
      const mustAnswer = n > lim.maxSteps || costUsd >= lim.maxCostUsd;
      if (mustAnswer && !forced) {
        forced = n > lim.maxSteps ? 'max_steps' : 'cost_cap';
        messages.push({ role: 'system', content: 'Limite de consultas desta pergunta atingido: responda AGORA com o que ja tem, sem chamar mais funcoes e sem inventar o que faltou — se algo ficou sem resposta, diga isso com naturalidade.' });
      }
      const res = await client.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(mustAnswer ? {} : { tools, tool_choice: 'auto' }),
      });
      const u = res.usage;
      const stepCost = u ? estimateCostUsd(res.model || model, { inTok: u.prompt_tokens, cachedInTok: u.prompt_tokens_details?.cached_tokens || 0, outTok: u.completion_tokens }) || 0 : 0;
      costUsd += stepCost;
      const step = { n, inTok: u?.prompt_tokens ?? null, outTok: u?.completion_tokens ?? null, costUsd: stepCost, tools: [] };
      trace.steps.push(step);

      const message = res.choices?.[0]?.message;
      const calls = mustAnswer ? [] : message?.tool_calls || [];
      if (calls.length === 0) {
        const answer = message?.content?.trim() || null;
        trace.outcome = forced || (answer ? 'ok' : 'empty');
        trace.answer = clip(answer, 400);
        return { answer, outcome: trace.outcome, steps: trace.steps.length, costUsd };
      }

      messages.push(message);
      const results = await Promise.all(
        calls.map(async (call) => {
          const name = call.function.name;
          const t0 = Date.now();
          let args = {};
          let result;
          let reused = false;
          try {
            args = JSON.parse(call.function.arguments || '{}');
            const key = name + JSON.stringify(args);
            if (seen.has(key)) {
              result = seen.get(key);
              reused = true;
            } else {
              result = await withTimeout(Promise.resolve(callTool(name, args)), lim.toolTimeoutMs);
              seen.set(key, result);
            }
          } catch (err) {
            result = { erro: String(err.message || err) };
          }
          step.tools.push({ name, args: clip(JSON.stringify(args), 200), ms: Date.now() - t0, erro: result?.erro ? clip(result.erro, 160) : undefined, reused: reused || undefined });
          return { id: call.id, content: clip(JSON.stringify(result), lim.maxToolResultChars) };
        }),
      );
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
    // inalcancavel na pratica (o ultimo passo nunca tem funcoes), mas nao deixa o laco acabar mudo
    trace.outcome = 'empty';
    return { answer: null, outcome: 'empty', steps: trace.steps.length, costUsd };
  } catch (err) {
    trace.outcome = err?.code === 'AI_BUDGET_EXCEEDED' ? 'budget' : 'error';
    trace.error = clip(err?.message || err, 200);
    throw err;
  } finally {
    trace.costUsd = costUsd;
    trace.totalMs = Date.now() - startedAt;
    saveTrace(trace);
  }
}

// ---------------- tracos ----------------
const MAX_TRACE_BYTES = 2 * 1024 * 1024;

function saveTrace(trace) {
  try {
    try {
      if (fs.statSync(TRACE_FILE).size > MAX_TRACE_BYTES) {
        const keep = fs.readFileSync(TRACE_FILE, 'utf-8').split('\n').filter(Boolean).slice(-500);
        fs.writeFileSync(TRACE_FILE, keep.join('\n') + '\n');
      }
    } catch {
      // arquivo ainda nao existe
    }
    fs.appendFileSync(TRACE_FILE, JSON.stringify(trace) + '\n');
  } catch (err) {
    console.error('Erro ao registrar traco do agente:', err);
  }
}

function readTraces() {
  try {
    return fs
      .readFileSync(TRACE_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Resumo e ultimas perguntas pra aba "Agente" do painel. */
export function getAgentOverview(limit = 40, now = Date.now()) {
  const all = readTraces();
  const since = Math.floor(now / 1000) - 30 * 86400;
  const recent = all.filter((t) => t.ts >= since);
  const n = recent.length;
  const outcomes = {};
  const tools = new Map();
  let steps = 0, cost = 0, ms = 0;
  for (const t of recent) {
    outcomes[t.outcome] = (outcomes[t.outcome] || 0) + 1;
    steps += t.steps.length;
    cost += t.costUsd || 0;
    ms += t.totalMs || 0;
    for (const s of t.steps) {
      for (const c of s.tools) {
        const e = tools.get(c.name) || { name: c.name, calls: 0, errors: 0 };
        e.calls += 1;
        if (c.erro) e.errors += 1;
        tools.set(c.name, e);
      }
    }
  }
  return {
    days: 30,
    questions: n,
    avgSteps: n ? steps / n : 0,
    avgCostUsd: n ? cost / n : 0,
    totalCostUsd: cost,
    avgMs: n ? ms / n : 0,
    outcomes,
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls),
    recent: all.slice(-limit).reverse(),
  };
}
