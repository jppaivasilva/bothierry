import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAiQueue, TEXTS } from '../src/bot/aiQueue.js';

let n = 0;
const tmpFile = () => path.join(os.tmpdir(), `bothierry-aiq-${process.pid}-${n++}.json`);
const wait = (cond, ms = 3000) =>
  new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) (clearInterval(iv), res());
      else if (Date.now() - t0 > ms) (clearInterval(iv), rej(new Error('timeout esperando condicao')));
    }, 5);
  });
const job = (id, sender = 'A', extra = {}) => ({ id, groupJid: 'g', senderJid: sender, senderName: sender, question: `pergunta ${id}`, text: `pergunta ${id}`, ...extra });
const quick = { aiRetryDelaysMs: [5, 5], sendRetryDelaysMs: [20, 20, 20, 20], aiTimeoutMs: 500 };

test('responde e envia; nao duplica pergunta repetida (reentrega do WhatsApp)', async () => {
  const sent = [];
  const q = createAiQueue({ file: tmpFile(), ...quick, deps: { answer: async (j) => `resp ${j.id}`, send: async (j, t) => sent.push([j.id, t]) } });
  q.start();
  assert.equal(q.enqueue(job('m1')).ok, true);
  assert.equal(q.enqueue(job('m1')).reason, 'duplicada');
  await wait(() => sent.length === 1);
  assert.deepEqual(sent[0], ['m1', 'resp m1']);
  await wait(() => q.getStats().pending === 0);
  assert.equal(q.enqueue(job('m1')).reason, 'duplicada', 'tambem depois de respondida');
});

test('limite de concorrencia: com 10 perguntas de pessoas diferentes, nunca passa de 3 ao mesmo tempo', async () => {
  let active = 0;
  let max = 0;
  let done = 0;
  const q = createAiQueue({ file: tmpFile(), concurrency: 3, ...quick, deps: { answer: async () => (active++, (max = Math.max(max, active)), await new Promise((r) => setTimeout(r, 20)), active--, 'ok'), send: async () => done++ } });
  q.start();
  for (let i = 0; i < 10; i++) assert.equal(q.enqueue(job(`m${i}`, `user${i}`)).ok, true);
  await wait(() => done === 10);
  assert.equal(max, 3);
});

test('mesma pessoa: uma de cada vez, em ordem; limite de pendentes por pessoa', async () => {
  const order = [];
  let active = 0;
  let overlap = false;
  const q = createAiQueue({ file: tmpFile(), maxPerUser: 3, ...quick, deps: { answer: async (j) => { const mine = j.senderJid === 'A'; if (mine) { active++; if (active > 1) overlap = true; } await new Promise((r) => setTimeout(r, 10)); if (mine) active--; return j.id; }, send: async (j) => order.push(j.id) } });
  q.start();
  for (const id of ['a1', 'a2', 'a3']) assert.equal(q.enqueue(job(id, 'A')).ok, true);
  assert.equal(q.enqueue(job('a4', 'A')).reason, 'limite_pessoa');
  assert.equal(q.enqueue(job('b1', 'B')).ok, true, 'outra pessoa nao e afetada');
  await wait(() => order.length === 4);
  assert.deepEqual(order.filter((x) => x.startsWith('a')), ['a1', 'a2', 'a3']);
  assert.equal(overlap, false);
});

test('fila cheia recusa com motivo (o bot avisa a pessoa)', () => {
  const q = createAiQueue({ file: tmpFile(), maxPending: 2, maxPerUser: 9, ...quick, deps: { answer: async () => 'x', send: async () => {} } });
  assert.equal(q.enqueue(job('1', 'A')).ok, true);
  assert.equal(q.enqueue(job('2', 'B')).ok, true);
  assert.equal(q.enqueue(job('3', 'C')).reason, 'cheia');
});

test('IA com erro passageiro: tenta de novo e responde normalmente', async () => {
  let calls = 0;
  const sent = [];
  const q = createAiQueue({ file: tmpFile(), ...quick, deps: { answer: async () => (++calls < 3 ? Promise.reject(Object.assign(new Error('rate limit'), { status: 429 })) : 'agora foi'), send: async (_j, t) => sent.push(t) } });
  q.start();
  q.enqueue(job('m1'));
  await wait(() => sent.length === 1);
  assert.deepEqual(sent, ['agora foi']);
  assert.equal(calls, 3);
});

test('IA falha de vez: SEMPRE vai uma resposta de contingencia (ninguem fica no vacuo)', async () => {
  const sent = [];
  const q = createAiQueue({ file: tmpFile(), ...quick, deps: { answer: async () => Promise.reject(new Error('quebrou geral')), send: async (_j, t) => sent.push(t) } });
  q.start();
  q.enqueue(job('m1'));
  await wait(() => sent.length === 1);
  assert.equal(sent[0], TEXTS.fallback);
  assert.equal(q.getStats().contingency24h, 1);
});

test('limite mensal de gasto: avisa o motivo em vez de ficar mudo', async () => {
  const sent = [];
  const q = createAiQueue({ file: tmpFile(), ...quick, deps: { answer: async () => Promise.reject(Object.assign(new Error('limite'), { code: 'AI_BUDGET_EXCEEDED' })), send: async (_j, t) => sent.push(t) } });
  q.start();
  q.enqueue(job('m1'));
  await wait(() => sent.length === 1);
  assert.equal(sent[0], TEXTS.budget);
});

test('IA travada: estoura o tempo, tenta de novo e cai na contingencia', async () => {
  const sent = [];
  const q = createAiQueue({ file: tmpFile(), ...quick, aiTimeoutMs: 30, deps: { answer: () => new Promise(() => {}), send: async (_j, t) => sent.push(t) } });
  q.start();
  q.enqueue(job('m1'));
  await wait(() => sent.length === 1, 4000);
  assert.equal(sent[0], TEXTS.fallback);
});

test('envio falha (WhatsApp fora): guarda a resposta pronta e reenvia SEM chamar a IA de novo', async () => {
  let aiCalls = 0;
  let sends = 0;
  const q = createAiQueue({ file: tmpFile(), ...quick, deps: { answer: async () => (aiCalls++, 'resposta cara'), send: async () => { if (++sends < 3) throw new Error('Connection Closed'); } } });
  q.start();
  q.enqueue(job('m1'));
  await wait(() => q.getStats().sent24h === 1);
  assert.equal(aiCalls, 1, 'a IA so foi paga uma vez');
  assert.equal(sends, 3);
});

test('envio que nunca funciona: desiste com registro do erro (aparece no painel)', async () => {
  const q = createAiQueue({ file: tmpFile(), ...quick, sendRetryDelaysMs: [5, 5], deps: { answer: async () => 'ok', send: async () => Promise.reject(new Error('sem conexao')) } });
  q.start();
  q.enqueue(job('m1'));
  await wait(() => q.getStats().failed24h === 1);
  const last = q.getStats().recent[0];
  assert.equal(last.status, 'falhou');
  assert.match(last.error, /sem conexao/);
  assert.equal(q.getStats().pending, 0);
});

test('reinicio do bot: pergunta pendente volta da fila e e respondida', async () => {
  const file = tmpFile();
  const never = createAiQueue({ file, ...quick, deps: { answer: () => new Promise(() => {}), send: async () => {} } });
  never.start();
  never.enqueue(job('m1', 'A', { quote: { key: { id: 'm1' }, message: { conversation: 'oi' } } }));
  await new Promise((r) => setTimeout(r, 20));
  // "reinicia": nova instancia le o mesmo arquivo
  const sent = [];
  const after = createAiQueue({ file, ...quick, deps: { answer: async (j) => `resp ${j.id}`, send: async (j, t, ex) => sent.push([j.id, t, j.quote.key.id, ex.msg]) } });
  assert.equal(after.getStats().pending, 1);
  after.start();
  await wait(() => sent.length === 1);
  assert.deepEqual(sent[0], ['m1', 'resp m1', 'm1', undefined]);
});

test('reinicio com foto: avisa que perdeu a foto (nao responde "sem ver" a imagem)', async () => {
  const file = tmpFile();
  const first = createAiQueue({ file, ...quick, deps: { answer: () => new Promise(() => {}), send: async () => {} } });
  first.start();
  first.enqueue(job('m1', 'A', { hadImage: true }), { msg: { fake: true } });
  await new Promise((r) => setTimeout(r, 20));
  const sent = [];
  const after = createAiQueue({ file, ...quick, deps: { answer: async () => 'nao devia chamar', send: async (_j, t) => sent.push(t) } });
  after.start();
  await wait(() => sent.length === 1);
  assert.equal(sent[0], TEXTS.lostImage);
});

test('pergunta velha demais (bot ficou muito tempo fora) expira em vez de responder fora de hora', async () => {
  let t = 1_000_000;
  const q = createAiQueue({ file: tmpFile(), ttlMs: 60_000, now: () => t, ...quick, deps: { answer: async () => 'x', send: async () => {} } });
  q.enqueue(job('m1'));
  t += 120_000;
  q.start();
  await wait(() => q.getStats().pending === 0);
  assert.equal(q.getStats().recent[0].status, 'expirada');
});

test('estatisticas: espera, enviadas e fila', async () => {
  const q = createAiQueue({ file: tmpFile(), ...quick, deps: { answer: async () => 'x', send: async () => {} } });
  q.start();
  q.enqueue(job('m1'));
  await wait(() => q.getStats().sent24h === 1);
  const s = q.getStats();
  assert.equal(s.pending, 0);
  assert.equal(s.failed24h, 0);
  assert.ok(s.avgTotalMs >= 0);
  for (const f of fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`bothierry-aiq-${process.pid}`))) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
});
