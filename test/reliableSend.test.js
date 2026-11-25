import test from 'node:test';
import assert from 'node:assert/strict';
import { installReliableSend, setLiveSocketProbe, configureReliableSend, isRetryable, getSendStats } from '../src/bot/reliableSend.js';

configureReliableSend({ gapMs: 5, attemptTimeoutMs: 200, maxTotalMs: 1500, backoffMs: [10, 10, 10], pollMs: 10 });

const boom = (statusCode, message) => Object.assign(new Error(message), { output: { statusCode } });
function fakeSock(impl) {
  const calls = [];
  const sock = { calls, sendMessage: async (...a) => (calls.push(a), impl(a, calls.length)) };
  installReliableSend(sock);
  return sock;
}

test('isRetryable: conexao/timeout/rede tentam de novo; permissao e conteudo invalido nao', () => {
  for (const e of [boom(428, 'Connection Closed'), boom(408, 'Timed Out'), boom(515, 'restart required'), new Error('read ECONNRESET'), new Error('socket hang up'), Object.assign(new Error('x'), { retryable: true })]) assert.equal(isRetryable(e), true, e.message);
  for (const e of [boom(403, 'forbidden'), boom(400, 'bad request'), new TypeError('x is not a function')]) assert.equal(isRetryable(e), false, e.message);
});

test('erro passageiro: reenvia sozinho e entrega', async () => {
  setLiveSocketProbe(null);
  const sock = fakeSock((_a, n) => (n < 3 ? Promise.reject(boom(428, 'Connection Closed')) : { key: { id: 'ok' } }));
  const res = await sock.sendMessage('g', { text: 'oi' });
  assert.equal(res.key.id, 'ok');
  assert.equal(sock.calls.length, 3);
});

test('erro definitivo falha na hora, sem insistir', async () => {
  setLiveSocketProbe(null);
  const sock = fakeSock(() => Promise.reject(boom(403, 'forbidden')));
  await assert.rejects(sock.sendMessage('g', { text: 'oi' }), /forbidden/);
  assert.equal(sock.calls.length, 1);
});

test('desconectado: espera reconectar e envia pelo socket NOVO (nao o antigo)', async () => {
  const oldSock = fakeSock(() => Promise.reject(boom(428, 'Connection Closed')));
  const newSock = fakeSock(() => ({ key: { id: 'novo' } }));
  let live = null;
  setLiveSocketProbe(() => live);
  setTimeout(() => (live = newSock), 80); // reconecta depois de um tempo
  const res = await oldSock.sendMessage('g', { text: 'resposta que a IA demorou pra montar' });
  assert.equal(res.key.id, 'novo');
  assert.equal(oldSock.calls.length, 0, 'nem tentou o socket morto');
  assert.equal(newSock.calls.length, 1);
  setLiveSocketProbe(null);
});

test('conexao que nao volta a tempo: falha com erro claro (a fila de respostas reenvia depois)', async () => {
  configureReliableSend({ maxTotalMs: 120 });
  setLiveSocketProbe(() => null);
  const sock = fakeSock(() => ({ key: { id: 'x' } }));
  await assert.rejects(sock.sendMessage('g', { text: 'oi' }), /sem conexao/);
  configureReliableSend({ maxTotalMs: 1500 });
  setLiveSocketProbe(null);
});

test('rajada: envios saem em ordem, um de cada vez, com intervalo minimo', async () => {
  setLiveSocketProbe(null);
  configureReliableSend({ gapMs: 30 });
  const times = [];
  let active = 0;
  let maxActive = 0;
  const sock = fakeSock(async (a) => {
    active++;
    maxActive = Math.max(maxActive, active);
    times.push([a[1].text, Date.now()]);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return { key: { id: a[1].text } };
  });
  await Promise.all(['a', 'b', 'c', 'd'].map((t) => sock.sendMessage('g', { text: t })));
  assert.deepEqual(times.map((x) => x[0]), ['a', 'b', 'c', 'd']);
  assert.equal(maxActive, 1);
  assert.ok(times[3][1] - times[0][1] >= 80, 'respeita o intervalo entre envios');
  configureReliableSend({ gapMs: 5 });
});

test('um envio que falha nao trava os seguintes na fila', async () => {
  setLiveSocketProbe(null);
  const sock = fakeSock((a) => (a[1].text === 'ruim' ? Promise.reject(boom(403, 'forbidden')) : { key: { id: a[1].text } }));
  const [r1, r2] = await Promise.allSettled([sock.sendMessage('g', { text: 'ruim' }), sock.sendMessage('g', { text: 'bom' })]);
  assert.equal(r1.status, 'rejected');
  assert.equal(r2.value.key.id, 'bom');
  assert.ok(getSendStats().failed >= 1);
});
