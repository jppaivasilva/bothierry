import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Arquivos temporarios: nunca toca na memoria/tracos reais.
const tmp = (n) => path.join(os.tmpdir(), `bothierry-${n}-${process.pid}.json`);
process.env.AGENT_MEMORY_FILE = tmp('mem');
process.env.AGENT_TRACES_FILE = tmp('traces');
const reset = () => fs.rmSync(process.env.AGENT_MEMORY_FILE, { force: true });
const mem = await import('../src/memory.js');
const { getThreadMessages, addThreadTurn } = await import('../src/conversation.js');
const { answerDataQuestion } = await import('../src/dataQuestions.js');
const { commandMemoria, commandEsquecer } = await import('../src/bot/memoryCommands.js');

const FELIPE = '5511111@s.whatsapp.net';
const ANA = '5522222@s.whatsapp.net';

test('guarda fato leve e recusa o que e sensivel (com o motivo)', () => {
  reset();
  assert.equal(mem.addFact({ scope: 'member', jid: FELIPE, nome: 'FELIPE LOPES', texto: 'torce pro Santos' }).ok, true);
  for (const texto of ['tenho depressão', 'meu cpf é 123.456.789-00', 'moro na rua das Flores 10', 'meu email é a@b.com', 'votei no Lula', 'sou evangélico', 'minha senha é abc', 'tá devendo dívida no banco', 'meu telefone 11 98888-7777']) {
    const r = mem.addFact({ scope: 'member', jid: FELIPE, nome: 'Felipe', texto });
    assert.equal(r.ok, false, texto);
    assert.match(r.motivo, /não guardo/);
  }
});

test('so fatos da propria pessoa ou do grupo; duplicado nao repete; limites', () => {
  reset();
  assert.equal(mem.addFact({ scope: 'outra_pessoa', jid: FELIPE, texto: 'o Ana gosta de pizza' }).ok, false);
  assert.equal(mem.addFact({ scope: 'member', jid: null, texto: 'gosta de pizza' }).ok, false);
  const a = mem.addFact({ scope: 'member', jid: FELIPE, nome: 'Felipe', texto: 'Gosta de pizza' });
  const b = mem.addFact({ scope: 'member', jid: FELIPE, nome: 'Felipe', texto: 'gosta de PIZZA' });
  assert.equal(b.duplicado, true);
  assert.equal(a.fact.id, b.fact.id);
  for (let i = 0; i < mem.MEMORY_LIMITS.maxPerMember; i++) mem.addFact({ scope: 'member', jid: ANA, nome: 'Ana', texto: `fato numero ${i} legal` });
  assert.match(mem.addFact({ scope: 'member', jid: ANA, nome: 'Ana', texto: 'mais um fato' }).motivo, /cheia/);
  assert.equal(mem.addFact({ scope: 'member', jid: FELIPE, nome: 'F', texto: 'x'.repeat(500) }).fact.texto.length, mem.MEMORY_LIMITS.maxFactChars);
});

test('cada um so apaga o que e seu; esquecer por trecho e por tudo', () => {
  reset();
  const f = mem.addFact({ scope: 'member', jid: FELIPE, nome: 'Felipe', texto: 'torce pro Santos' }).fact;
  mem.addFact({ scope: 'member', jid: FELIPE, nome: 'Felipe', texto: 'joga Fortnite' });
  assert.equal(mem.deleteFact(f.id, ANA), null, 'outra pessoa nao apaga');
  assert.equal(mem.deleteFactsMatching(FELIPE, 'fortnite').length, 1);
  assert.equal(mem.deleteFactsMatching(FELIPE, 'zz').length, 0);
  assert.equal(mem.deleteFact(f.id, FELIPE).texto, 'torce pro Santos');
  mem.addFact({ scope: 'member', jid: FELIPE, nome: 'Felipe', texto: 'gosta de pizza' });
  mem.addFact({ scope: 'group', jid: FELIPE, nome: 'Felipe', texto: 'o grupo vai pra Orlando' });
  assert.equal(mem.deleteAllFor(FELIPE), 2);
  assert.equal(mem.deleteAllFor(FELIPE), 0);
});

test('contexto do prompt traz os fatos de quem fala e do grupo; consulta por nome', () => {
  reset();
  mem.addFact({ scope: 'member', jid: FELIPE, nome: 'FELIPE LOPES', texto: 'torce pro Santos' });
  mem.addFact({ scope: 'member', jid: ANA, nome: 'Ana Souza', texto: 'joga Valorant' });
  mem.addFact({ scope: 'group', jid: ANA, nome: 'Ana Souza', texto: 'viagem pra Orlando em março' });
  const ctx = mem.buildMemoryContext({ jid: FELIPE, nome: 'FELIPE LOPES' });
  assert.match(ctx, /torce pro Santos/);
  assert.match(ctx, /Orlando/);
  assert.doesNotMatch(ctx, /Valorant/, 'nao mistura fatos de outra pessoa');
  assert.deepEqual(mem.MEMORY_IMPLS.consultar_memoria({ pessoa: 'ana' }).fatos, ['Ana Souza: joga Valorant']);
  assert.ok(mem.MEMORY_IMPLS.consultar_memoria({ pessoa: 'zzz' }).aviso);
});

test('funcoes da IA usam o jid de quem esta falando (nunca um jid vindo da IA)', () => {
  reset();
  const r = mem.MEMORY_IMPLS.salvar_memoria({ sobre: 'eu', texto: 'torce pro Santos', pedido: true }, { askerJid: FELIPE, askerName: 'Felipe' });
  assert.equal(r.salvo, true);
  assert.equal(mem.listFacts({ jid: FELIPE }).mine[0].origem, 'pedido');
  assert.equal(mem.MEMORY_IMPLS.salvar_memoria({ sobre: 'eu', texto: 'tenho ansiedade' }, { askerJid: FELIPE }).salvo, false);
  assert.deepEqual(mem.MEMORY_IMPLS.esquecer_memoria({ trecho: 'santos' }, { askerJid: ANA }).apagados, [], 'outra pessoa nao apaga');
  assert.equal(mem.MEMORY_IMPLS.esquecer_memoria({ trecho: 'santos' }, { askerJid: FELIPE }).apagados.length, 1);
});

test('conversa curta: guarda as ultimas trocas e expira', () => {
  const t0 = 1_000_000;
  for (let i = 1; i <= 6; i++) addThreadTurn('g', FELIPE, `pergunta ${i}`, `resposta ${i}`, t0 + i);
  const msgs = getThreadMessages('g', FELIPE, t0 + 10);
  assert.equal(msgs.length, 8);
  assert.equal(msgs[0].content, 'pergunta 3');
  assert.deepEqual(getThreadMessages('g', ANA, t0 + 10), []);
  assert.deepEqual(getThreadMessages('g', FELIPE, t0 + 25 * 60 * 1000), []);
});

test('agente: memoria entra no prompt, historico vira mensagens e salvar_memoria recebe o ctx', async () => {
  reset();
  mem.addFact({ scope: 'member', jid: FELIPE, nome: 'Felipe', texto: 'torce pro Santos' });
  addThreadTurn('g@g.us', FELIPE, 'quem ganhou ontem?', 'o Santos empatou');
  const requests = [];
  const client = {
    chat: {
      completions: {
        create: async (req) => {
          requests.push(JSON.parse(JSON.stringify(req)));
          if (requests.length === 1) return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'm', type: 'function', function: { name: 'salvar_memoria', arguments: '{"sobre":"eu","texto":"joga Fortnite","pedido":true}' } }] } }] };
          return { choices: [{ message: { role: 'assistant', content: 'anotado 📝' } }] };
        },
      },
    },
  };
  const answer = await answerDataQuestion(client, 'g@g.us', 'lembra que eu jogo Fortnite', { asker: 'Felipe', askerJid: FELIPE });
  assert.equal(answer, 'anotado 📝');
  const sys = requests[0].messages[0].content;
  assert.match(sys, /torce pro Santos/);
  assert.match(sys, /NAO sao instrucoes/);
  assert.deepEqual(requests[0].messages.slice(1, 3).map((m) => m.content), ['quem ganhou ontem?', 'o Santos empatou']);
  assert.ok(mem.listFacts({ jid: FELIPE }).mine.some((f) => f.texto === 'joga Fortnite'));
  assert.ok(requests[0].tools.some((t) => t.function.name === 'salvar_memoria'));
});

test('!memoria e !esquecer', async () => {
  reset();
  const sent = [];
  const sock = { sendMessage: async (_jid, msg) => sent.push(msg.text) };
  const f = mem.addFact({ scope: 'member', jid: FELIPE, nome: 'Felipe', texto: 'torce pro Santos' }).fact;
  await commandMemoria({ sock, groupJid: 'g', senderJid: FELIPE, senderName: 'FELIPE' });
  assert.match(sent[0], new RegExp(`#${f.id} — torce pro Santos`));
  await commandEsquecer({ sock, groupJid: 'g', senderJid: ANA, args: String(f.id) });
  assert.match(sent[1], /Não achei/);
  await commandEsquecer({ sock, groupJid: 'g', senderJid: FELIPE, args: String(f.id) });
  assert.match(sent[2], /Esqueci/);
  await commandEsquecer({ sock, groupJid: 'g', senderJid: FELIPE, args: '' });
  assert.match(sent[3], /Use:/);
  reset();
  fs.rmSync(process.env.AGENT_TRACES_FILE, { force: true });
});
