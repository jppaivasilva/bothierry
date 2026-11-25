// Envio confiavel: TUDO que o bot manda (sock.sendMessage) passa por aqui.
//  - fila unica com intervalo minimo entre envios (rajada de respostas nao
//    sobrecarrega o WhatsApp nem o bot);
//  - sempre usa o socket VIVO no momento do envio (o socket do handler pode
//    ter sido trocado numa reconexao enquanto a IA pensava);
//  - se estiver desconectado, ESPERA reconectar em vez de falhar;
//  - erro passageiro (conexao fechada, timeout, rede) -> tenta de novo com espera;
//  - erro definitivo (sem permissao, conteudo invalido) -> falha na hora.
const cfg = { gapMs: 700, attemptTimeoutMs: 25_000, maxTotalMs: 4 * 60_000, backoffMs: [1500, 4000, 10_000, 20_000], pollMs: 1000 };
const stats = { sent: 0, retried: 0, failed: 0, waitedForConnection: 0, queued: 0, lastError: null, lastErrorAt: null };

let probe = null; // () => socket conectado agora (ou null)
let chain = Promise.resolve();
let lastSentAt = 0;

/** Define quem diz qual socket esta conectado agora (connection.js). Sem isso, usa o socket que chamou. */
export function setLiveSocketProbe(fn) {
  probe = fn;
}
/** So pra testes: ajusta tempos. */
export function configureReliableSend(over) {
  Object.assign(cfg, over);
}
export const getSendStats = () => ({ ...stats });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => (timer = setTimeout(() => rej(Object.assign(new Error('envio demorou demais (timeout)'), { retryable: true })), ms)))]).finally(() => clearTimeout(timer));
}

/** Erro passageiro (vale tentar de novo) ou definitivo? */
export function isRetryable(err) {
  if (err?.retryable) return true;
  const code = err?.output?.statusCode ?? err?.status ?? err?.statusCode;
  if ([400, 401, 403, 404, 406].includes(code)) return false;
  if ([408, 428, 429, 500, 502, 503, 504, 515].includes(code)) return true;
  return /closed|time.?out|stream|network|econn|etimedout|eai_again|socket|rate|overlimit|not-acknowledged|reconnect|offline|connection|disconnect/i.test(String(err?.message || err));
}

function enqueue(task) {
  stats.queued++;
  const enqueuedAt = Date.now();
  const p = chain
    .then(async () => {
      const wait = lastSentAt + cfg.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
    })
    .then(() => task(enqueuedAt + cfg.maxTotalMs)) // prazo conta desde que entrou na fila
    .finally(() => {
      stats.queued--;
      lastSentAt = Date.now();
    });
  chain = p.catch(() => {});
  return p;
}

async function liveSocket(sock, deadline) {
  let waited = false;
  for (;;) {
    const live = probe ? probe() : sock;
    if (live) return live;
    if (Date.now() >= deadline) return null;
    if (!waited) {
      waited = true;
      stats.waitedForConnection++;
    }
    await sleep(cfg.pollMs);
  }
}

async function deliver(sock, jid, content, options, deadline) {
  let attempt = 0;
  let lastErr = null;
  for (;;) {
    const live = await liveSocket(sock, deadline);
    if (!live) {
      stats.failed++;
      throw lastErr || new Error('sem conexao com o WhatsApp (esperei reconectar e nao voltou a tempo)');
    }
    const raw = live.rawSendMessage || live.sendMessage.bind(live);
    try {
      const res = await withTimeout(raw(jid, content, options), cfg.attemptTimeoutMs);
      stats.sent++;
      return res;
    } catch (err) {
      lastErr = err;
      stats.lastError = String(err?.message || err).slice(0, 200);
      stats.lastErrorAt = Date.now();
      if (!isRetryable(err) || attempt >= cfg.backoffMs.length || Date.now() >= deadline) {
        stats.failed++;
        throw err;
      }
      stats.retried++;
      await sleep(Math.min(cfg.backoffMs[attempt++], Math.max(0, deadline - Date.now())));
    }
  }
}

/** Troca o sendMessage do socket pela versao confiavel (guarda o original em rawSendMessage). */
export function installReliableSend(sock) {
  if (sock.rawSendMessage) return;
  const original = sock.sendMessage.bind(sock);
  sock.rawSendMessage = original;
  sock.sendMessage = (jid, content, options) => enqueue((deadline) => deliver(sock, jid, content, options, deadline));
}
