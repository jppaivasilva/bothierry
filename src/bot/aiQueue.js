// Fila das perguntas dirigidas ao bot (IA). Objetivos:
//  1) NENHUMA pergunta fica sem resposta: se a IA falhar, vai uma resposta de
//     contingencia; se o WhatsApp estiver fora, a resposta espera e e reenviada;
//     se o bot reiniciar, as perguntas pendentes voltam (ai_queue.json);
//  2) o bot nao se sobrecarrega: no maximo N perguntas ao mesmo tempo (IA +
//     imagens consomem CPU/memoria), uma por pessoa por vez, em ordem de chegada;
//  3) a resposta da IA ja pronta nunca e refeita (nao paga duas vezes) se so o
//     envio falhou.
// A fila e generica: quem usa injeta o que fazer (deps). Ver src/bot/aiJobs.js.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = process.env.AI_QUEUE_FILE || path.join(__dirname, '..', '..', 'ai_queue.json');

export const TEXTS = {
  fallback: 'Travei aqui e não consegui pensar numa resposta 😵 manda de novo daqui a pouquinho?',
  budget: 'Meu limite de gastos com IA deste mês acabou 💸 volto a conversar no dia 1º — os comandos (!menu) continuam funcionando normal.',
  lostImage: 'Reiniciei aqui no meio do caminho e perdi a foto 😅 manda de novo?',
  userLimit: 'Calma, tô respondendo as suas perguntas anteriores 😅 já já eu chego nessa.',
  full: 'Tô com muita pergunta na fila agora 🥵 tenta de novo em um minutinho?',
};

const isTransientAi = (err) => {
  if (err?.code === 'AI_BUDGET_EXCEEDED') return false;
  if ([408, 409, 429].includes(err?.status) || err?.status >= 500) return true;
  return /time.?out|econn|etimedout|eai_again|fetch failed|network|socket|overloaded|rate/i.test(String(err?.message || err));
};

const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n) + '…' : String(s ?? ''));

export function createAiQueue({
  file = DEFAULT_FILE,
  concurrency = 3,
  maxPending = 100,
  maxPerUser = 3,
  ttlMs = 30 * 60_000,
  aiRetryDelaysMs = [2000, 6000],
  aiTimeoutMs = 90_000,
  sendRetryDelaysMs = [30_000, 60_000, 120_000, 300_000],
  historySize = 200,
  deps,
  now = () => Date.now(),
}) {
  // deps: { answer(job, extras) -> texto, send(job, texto, extras) -> Promise, presence?(job, estado), lostImage?(job) }
  let pending = [];
  let history = [];
  const running = new Set();
  const extras = new Map(); // id -> { msg } (so em memoria: a mensagem original, usada pra imagem e pro "reply")
  let timer = null;
  let started = false;

  function load() {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
      pending = Array.isArray(d.pending) ? d.pending : [];
      history = Array.isArray(d.history) ? d.history : [];
    } catch {
      pending = [];
      history = [];
    }
  }
  function save() {
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ pending, history: history.slice(-historySize) }));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error('Erro ao gravar a fila de respostas:', err);
    }
  }
  const record = (job, status, error) => {
    history.push({ id: job.id, ts: Math.floor(now() / 1000), asker: job.senderName, question: clip(job.question, 120), status, kind: job.answerKind || null, attempts: (job.sendAttempts || 0) + (status === 'enviada' ? 1 : 0), waitMs: (job.startedAt || now()) - job.enqueuedAt, totalMs: now() - job.enqueuedAt, error: error ? clip(error, 160) : undefined });
    history = history.slice(-historySize);
  };

  function finish(job, status, error) {
    pending = pending.filter((j) => j.id !== job.id);
    extras.delete(job.id);
    running.delete(job.id);
    record(job, status, error);
    save();
  }

  /** Coloca uma pergunta na fila. Devolve { ok:true } ou { ok:false, reason:'duplicada'|'limite_pessoa'|'cheia' }. */
  function enqueue(job, ex = {}) {
    if (pending.some((j) => j.id === job.id) || history.some((h) => h.id === job.id)) return { ok: false, reason: 'duplicada' };
    if (pending.filter((j) => j.senderJid === job.senderJid).length >= maxPerUser) return { ok: false, reason: 'limite_pessoa' };
    if (pending.length >= maxPending) return { ok: false, reason: 'cheia' };
    pending.push({ sendAttempts: 0, answer: null, notBefore: 0, ...job, enqueuedAt: now() });
    extras.set(job.id, ex);
    save();
    schedule(0);
    return { ok: true, position: pending.length };
  }

  const withTimeout = (p, ms) => {
    let t;
    return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(Object.assign(new Error('a IA demorou demais'), { code: 'AI_TIMEOUT' })), ms)))]).finally(() => clearTimeout(t));
  };

  async function answerWithRetry(job) {
    for (let i = 0; ; i++) {
      try {
        return await withTimeout(Promise.resolve(deps.answer(job, extras.get(job.id) || {})), aiTimeoutMs);
      } catch (err) {
        if (i >= aiRetryDelaysMs.length || !(isTransientAi(err) || err?.code === 'AI_TIMEOUT')) throw err;
        await new Promise((r) => setTimeout(r, aiRetryDelaysMs[i]));
      }
    }
  }

  async function runJob(job) {
    job.startedAt ||= now();
    try {
      if (!job.answer) {
        if (job.hadImage && !extras.get(job.id)?.msg) {
          job.answer = TEXTS.lostImage; // reiniciou: a foto nao existe mais
          job.answerKind = 'foto_perdida';
        } else {
          try {
            deps.presence?.(job, 'composing');
            job.answer = (await answerWithRetry(job)) || TEXTS.fallback;
            job.answerKind = job.answer === TEXTS.fallback ? 'contingencia' : 'ia';
          } catch (err) {
            console.error('Erro ao gerar resposta da IA (vai resposta de contingencia):', err?.message || err);
            job.answer = err?.code === 'AI_BUDGET_EXCEEDED' ? TEXTS.budget : TEXTS.fallback;
            job.answerKind = err?.code === 'AI_BUDGET_EXCEEDED' ? 'orcamento' : 'contingencia';
          }
        }
        save(); // resposta pronta fica guardada: se so o envio falhar, nao paga a IA de novo
      }
      await deps.send(job, job.answer, extras.get(job.id) || {});
      finish(job, 'enviada');
    } catch (err) {
      job.sendAttempts = (job.sendAttempts || 0) + 1;
      job.lastError = clip(err?.message || err, 160);
      const expired = now() - job.enqueuedAt > ttlMs;
      if (expired || job.sendAttempts > sendRetryDelaysMs.length) {
        console.error(`Resposta nao enviada (desisti apos ${job.sendAttempts} tentativas):`, job.lastError);
        finish(job, expired ? 'expirada' : 'falhou', job.lastError);
      } else {
        job.notBefore = now() + sendRetryDelaysMs[job.sendAttempts - 1];
        running.delete(job.id);
        save();
      }
    } finally {
      running.delete(job.id);
      try {
        deps.presence?.(job, 'paused');
      } catch {
        // presenca e so enfeite
      }
      schedule(0);
    }
  }

  function tick() {
    timer = null;
    if (!started) return;
    const t = now();
    // vencidos de vez (ficaram na fila alem do TTL, ex.: bot ficou fora do ar)
    for (const job of [...pending]) {
      if (!running.has(job.id) && t - job.enqueuedAt > ttlMs) finish(job, 'expirada', job.lastError || 'passou do tempo limite');
    }
    const busyUsers = new Set(pending.filter((j) => running.has(j.id)).map((j) => j.senderJid));
    for (const job of pending) {
      if (running.size >= concurrency) break;
      if (running.has(job.id) || busyUsers.has(job.senderJid) || job.notBefore > t) continue;
      running.add(job.id);
      busyUsers.add(job.senderJid);
      runJob(job);
    }
    const next = pending.filter((j) => !running.has(j.id) && j.notBefore > t).map((j) => j.notBefore - t);
    if (next.length) schedule(Math.min(...next) + 5);
  }

  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, ms);
    timer.unref?.();
  }

  /** Comeca a processar (chamar quando o WhatsApp conectar). Retoma o que ficou pendente do ultimo ciclo. */
  function start() {
    started = true;
    schedule(0);
  }

  function getStats() {
    const t = now();
    const dayAgo = Math.floor(t / 1000) - 86400;
    const last24 = history.filter((h) => h.ts >= dayAgo);
    const sent = last24.filter((h) => h.status === 'enviada');
    return {
      pending: pending.length,
      running: running.size,
      waitingRetry: pending.filter((j) => !running.has(j.id) && j.notBefore > t).length,
      oldestWaitSec: pending.length ? Math.round((t - Math.min(...pending.map((j) => j.enqueuedAt))) / 1000) : 0,
      sent24h: sent.length,
      failed24h: last24.filter((h) => h.status !== 'enviada').length,
      avgWaitMs: sent.length ? Math.round(sent.reduce((s, h) => s + h.waitMs, 0) / sent.length) : 0,
      avgTotalMs: sent.length ? Math.round(sent.reduce((s, h) => s + h.totalMs, 0) / sent.length) : 0,
      contingency24h: last24.filter((h) => h.kind && h.kind !== 'ia').length,
      recent: history.slice(-30).reverse(),
    };
  }

  load();
  return { enqueue, start, getStats, _pending: () => pending };
}
