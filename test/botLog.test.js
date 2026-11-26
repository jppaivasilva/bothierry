import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = (n) => path.join(os.tmpdir(), `bothierry-${n}-${process.pid}`);
process.env.BOT_ACTIONS_FILE = tmp('actions.jsonl');
process.env.INSULT_STATE_FILE = tmp('insults.json');
process.env.INSULT_HISTORY_FILE = tmp('history.json');
process.env.AGENT_TRACES_FILE = tmp('botlog-traces.jsonl');
process.env.AGENT_MEMORY_FILE = tmp('botlog-mem.json');
const reset = () => [process.env.BOT_ACTIONS_FILE, process.env.INSULT_STATE_FILE, process.env.INSULT_HISTORY_FILE].forEach((f) => fs.rmSync(f, { force: true }));

const L = await import('../src/botLog.js');
const { handleBotInsult } = await import('../src/bot/insults.js');
const { recordParticipantsUpdate } = await import('../src/bot/groupEvents.js');
const { answerDataQuestion } = await import('../src/dataQuestions.js');

const DANIEL = '5511999@s.whatsapp.net';
const fakeSock = (opts = {}) => {
  const sent = [];
  const removed = [];
  return {
    sent,
    removed,
    sendMessage: async (jid, content) => (sent.push(content), { key: { id: `id${sent.length}` } }),
    groupParticipantsUpdate: async (g, ps, act) => {
      if (opts.failRemove) throw new Error('not-authorized');
      removed.push([ps, act]);
    },
  };
};

test('diario: registra, filtra por pessoa (sem acento, por apelido), tipo e periodo', () => {
  reset();
  const now = Math.floor(Date.now() / 1000);
  L.logBotAction({ tipo: 'expulsao', jid: DANIEL, nome: 'Daniel Guimarães', resumo: 'expulsei o Daniel Guimarães' });
  L.logBotAction({ tipo: 'regra', jid: 'x', nome: 'Ana', resumo: 'avisei Ana da regra 93' });
  assert.equal(L.getRecentActions().length, 2);
  assert.equal(L.getRecentActions({ nomes: ['daniel'] }).length, 1);
  assert.equal(L.getRecentActions({ nomes: ['guimaraes', 'Daniel Guimarães'] })[0].tipo, 'expulsao', 'sem acento e por nome completo');
  assert.equal(L.getRecentActions({ tipo: 'regra' })[0].nome, 'Ana');
  assert.equal(L.getRecentActions({ dias: 1 }, now + 3 * 86400).length, 0, 'fora do periodo');
  assert.match(L.buildRecentActionsContext({}, now), /expulsei o Daniel/);
  assert.equal(L.buildRecentActionsContext({}, now + 10 * 86400), '');
});

test('acoes_do_bot: apelido vira nome completo; sem registro NAO afirma que nao aconteceu', () => {
  reset();
  L.logBotAction({ tipo: 'expulsao', jid: DANIEL, nome: 'Daniel Guimarães', resumo: 'expulsei o Daniel Guimarães por 3 insultos' });
  const found = L.acoesDoBot({ pessoa: 'guima' }, (p) => [p, 'Daniel Guimarães', 'Daniel']);
  assert.equal(found.acoes.length, 1);
  assert.match(found.acoes[0].o_que_aconteceu, /3 insultos/);
  const none = L.acoesDoBot({ pessoa: 'ninguem' }, (p) => [p]);
  assert.deepEqual(none.acoes, []);
  assert.match(none.aviso, /NAO prova que nao aconteceu/);
});

test('insultos 1 e 2: aviso + diario com o que a pessoa disse', async () => {
  reset();
  const sock = fakeSock();
  await handleBotInsult({ sock, groupJid: 'g', senderJid: DANIEL, senderName: 'DANIEL GUIMARAES', text: '@5511888 vai a merda' });
  await handleBotInsult({ sock, groupJid: 'g', senderJid: DANIEL, senderName: 'DANIEL GUIMARAES', text: 'bot lixo' });
  const acts = L.getRecentActions({ tipo: 'aviso_insulto' });
  assert.equal(acts.length, 2);
  assert.match(acts[1].resumo, /aviso 1\/3.*vai a merda/);
  assert.doesNotMatch(acts[1].resumo, /@/, 'tira a marcacao do texto');
});

test('3o insulto: expulsa e o diario guarda o MOTIVO completo (os 3 insultos), mesmo o contador sendo apagado', async () => {
  reset();
  const sock = fakeSock();
  for (const text of ['vai a merda', 'bot lixo', 'seu inutil']) await handleBotInsult({ sock, groupJid: 'g', senderJid: DANIEL, senderName: 'Daniel Guimarães', text });
  assert.deepEqual(sock.removed, [[[DANIEL], 'remove']]);
  const exp = L.getRecentActions({ tipo: 'expulsao' })[0];
  assert.match(exp.resumo, /EU expulsei o Daniel Guimarães/);
  for (const t of ['vai a merda', 'bot lixo', 'seu inutil']) assert.match(exp.resumo, new RegExp(t));
  assert.equal(JSON.parse(fs.readFileSync(process.env.INSULT_STATE_FILE, 'utf-8'))[DANIEL], undefined, 'contador zerado');
});

test('expulsao que falha (bot sem permissao) tambem fica registrada, sem dizer que expulsou', async () => {
  reset();
  const sock = fakeSock({ failRemove: true });
  for (let i = 0; i < 3; i++) await handleBotInsult({ sock, groupJid: 'g', senderJid: DANIEL, senderName: 'Daniel', text: 'xingamento' });
  const exp = L.getRecentActions({ tipo: 'expulsao' })[0];
  assert.match(exp.resumo, /NAO consegui remover/);
});

test('evento de grupo de outro grupo / acao irrelevante e ignorado sem erro', () => {
  reset();
  assert.doesNotThrow(() => recordParticipantsUpdate({ id: 'outro@g.us', participants: [DANIEL], action: 'add' }));
  assert.doesNotThrow(() => recordParticipantsUpdate({ id: 'outro@g.us', participants: [{ id: DANIEL }], action: 'promote' }));
  assert.equal(L.getRecentActions().length, 0);
});

test('agente: o diario entra no prompt e a funcao acoes_do_bot esta disponivel', async () => {
  reset();
  L.logBotAction({ tipo: 'expulsao', jid: DANIEL, nome: 'Daniel Guimarães', resumo: 'EU expulsei o Daniel Guimarães do grupo porque ele me insultou 3 vezes' });
  let req;
  const client = { chat: { completions: { create: async (r) => ((req = r), { choices: [{ message: { role: 'assistant', content: 'ok' } }] }) } } };
  await answerDataQuestion(client, 'g@g.us', 'por que voce tirou o guima do grupo?', { asker: 'Fulano', askerJid: '5522@s.whatsapp.net' });
  const sys = req.messages[0].content;
  assert.match(sys, /EU expulsei o Daniel Guimarães/);
  assert.match(sys, /NUNCA afirme que algo nao aconteceu/);
  assert.ok(req.tools.some((t) => t.function.name === 'acoes_do_bot'));
  reset();
  for (const f of [process.env.AGENT_TRACES_FILE, process.env.AGENT_MEMORY_FILE]) fs.rmSync(f, { force: true });
});

// ---------------- historico permanente de insultos ----------------
const H = await import('../src/insultHistory.js');
const { commandInsultos } = await import('../src/bot/memoryCommands.js');
const resetH = () => fs.rmSync(process.env.INSULT_HISTORY_FILE, { force: true });

test('historico: cada insulto e cada expulsao ficam registrados pra sempre (mesmo depois do contador zerar)', async () => {
  reset();
  resetH();
  const sock = fakeSock();
  // 1o ciclo: 3 insultos -> expulso. 2o ciclo (voltou): 3 insultos -> expulso de novo.
  for (let i = 0; i < 6; i++) await handleBotInsult({ sock, groupJid: 'g', senderJid: DANIEL, senderName: 'Daniel Guimarães', text: `xingamento ${i + 1}` });
  const [s] = H.findInsultStats(['daniel']);
  assert.equal(s.total_insultos, 6);
  assert.equal(s.vezes_expulso, 2);
  assert.equal(s.ultimo_insulto.texto, 'xingamento 6');
  assert.ok(s.ultima_expulsao);
});

test('historico: expulsao que falhou NAO conta como expulso', async () => {
  reset();
  resetH();
  const sock = fakeSock({ failRemove: true });
  for (let i = 0; i < 3; i++) await handleBotInsult({ sock, groupJid: 'g', senderJid: DANIEL, senderName: 'Daniel', text: 'x' });
  assert.equal(H.getInsultStatsByJid(DANIEL).vezes_expulso, 0);
  assert.equal(H.getInsultStatsByJid(DANIEL).total_insultos, 3);
});

test('historico: ranking, busca por apelido e aviso honesto quando nao ha registro', () => {
  resetH();
  H.recordInsult({ jid: 'a@s', nome: 'Ana Souza', texto: 'x' });
  H.recordInsult({ jid: 'b@s', nome: 'Beto Lima', texto: 'y' });
  H.recordInsult({ jid: 'b@s', nome: 'Beto Lima', texto: 'z' });
  H.recordExpulsion({ jid: 'a@s', nome: 'Ana Souza' });
  const r = H.getInsultRanking();
  assert.equal(r.pessoas[0].nome, 'Ana Souza', 'expulsoes pesam primeiro');
  assert.deepEqual(r.totais, { pessoas_com_insulto: 2, insultos: 3, expulsoes: 1 });
  assert.equal(H.historicoInsultos({ pessoa: 'betinho' }, () => ['betinho', 'Beto Lima']).pessoas[0].total_insultos, 2);
  assert.match(H.historicoInsultos({ pessoa: 'fulano' }).aviso, /nao prova/);
  assert.equal(H.historicoInsultos({}).pessoas.length, 2, 'sem pessoa = quadro geral');
});

test('!insultos mostra o quadro (e uma mensagem leve quando ninguem xingou)', async () => {
  resetH();
  const out = [];
  const sock = { sendMessage: async (_j, m) => out.push(m.text) };
  await commandInsultos({ sock, groupJid: 'g' });
  assert.match(out[0], /Ninguém me xingou/);
  H.recordInsult({ jid: 'a@s', nome: 'Ana Souza', texto: 'x' });
  H.recordExpulsion({ jid: 'a@s', nome: 'Ana Souza' });
  await commandInsultos({ sock, groupJid: 'g' });
  assert.match(out[1], /1\. Ana Souza — 1 insulto · expulso 1x/);
  assert.match(out[1], /1 expulsão/);
  resetH();
  for (const f of [process.env.BOT_ACTIONS_FILE, process.env.INSULT_STATE_FILE]) fs.rmSync(f, { force: true });
});
