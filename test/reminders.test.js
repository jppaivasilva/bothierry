import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = (n) => path.join(os.tmpdir(), `bothierry-${n}-${process.pid}.json`);
process.env.REMINDERS_FILE = tmp('rem');
process.env.AGENT_TRACES_FILE = tmp('rem-traces');
process.env.AGENT_MEMORY_FILE = tmp('rem-mem');
const reset = () => fs.rmSync(process.env.REMINDERS_FILE, { force: true });
const R = await import('../src/reminders.js');
const { sendDueReminders, commandLembretes, commandCancelarLembrete } = await import('../src/bot/reminderFlow.js');
const { answerDataQuestion } = await import('../src/dataQuestions.js');

const FELIPE = '5511111@s.whatsapp.net';
const ANA = '5522222@s.whatsapp.net';
const G = '120363@g.us';
const NOW = Math.floor(Date.UTC(2026, 10, 25, 15, 0, 0) / 1000); // 25/11/2026 12:00 em Brasilia (UTC-3)

test('brToTs: horario de Brasilia (UTC-3) e datas invalidas', () => {
  assert.equal(R.brToTs('2026-11-25', '12:00'), NOW);
  assert.equal(R.brToTs('2026-12-04', '20:30'), Math.floor(Date.UTC(2026, 11, 4, 23, 30) / 1000));
  for (const [d, t] of [['2026-02-31', '10:00'], ['2026-13-01', '10:00'], ['2026-11-25', '25:00'], ['2026-11-25', '12:60'], ['amanha', '10:00'], ['2026-11-25', 'meio-dia']]) assert.equal(R.brToTs(d, t), null, `${d} ${t}`);
});

test('addReminder: relativo, absoluto e as recusas (passado, longe demais, limite por pessoa)', () => {
  reset();
  const rel = R.addReminder({ jid: FELIPE, nome: 'FELIPE', groupJid: G, texto: 'tomar agua', em_minutos: 90 }, NOW);
  assert.equal(rel.reminder.dueTs, NOW + 5400);
  const abs = R.addReminder({ jid: FELIPE, nome: 'FELIPE', groupJid: G, texto: 'comprar o ingresso', data: '2026-11-27', hora: '20:00' }, NOW);
  assert.equal(abs.ok, true);
  assert.match(R.addReminder({ jid: FELIPE, groupJid: G, texto: 'x ontem', data: '2026-11-24', hora: '10:00' }, NOW).motivo, /passou/);
  assert.match(R.addReminder({ jid: FELIPE, groupJid: G, texto: 'daqui um ano', data: '2027-12-01', hora: '10:00' }, NOW).motivo, /90 dias/);
  assert.match(R.addReminder({ jid: FELIPE, groupJid: G, texto: 'sem hora', data: '2026-11-27' }, NOW).motivo, /invalida/);
  assert.match(R.addReminder({ jid: FELIPE, groupJid: G, texto: 'a', em_minutos: 10 }, NOW).motivo, /do que lembrar/);
  assert.equal(R.addReminder({ jid: FELIPE, groupJid: G, texto: 'rapido', em_minutos: 0.1 }, NOW).ok, false);
  for (let i = 0; i < 8; i++) R.addReminder({ jid: FELIPE, groupJid: G, texto: `lembrete ${i}`, em_minutos: 60 + i }, NOW);
  assert.match(R.addReminder({ jid: FELIPE, groupJid: G, texto: 'um a mais', em_minutos: 5 }, NOW).motivo, /10 lembretes/);
  assert.equal(R.addReminder({ jid: ANA, groupJid: G, texto: 'outra pessoa pode', em_minutos: 5 }, NOW).ok, true);
});

test('vencidos saem; atrasados demais sao descartados; so o dono cancela', () => {
  reset();
  const a = R.addReminder({ jid: FELIPE, groupJid: G, texto: 'vence ja', em_minutos: 1 }, NOW).reminder;
  const b = R.addReminder({ jid: FELIPE, groupJid: G, texto: 'vence depois', em_minutos: 120 }, NOW).reminder;
  assert.deepEqual(R.getDueReminders(NOW + 30).map((r) => r.id), []);
  assert.deepEqual(R.getDueReminders(NOW + 61).map((r) => r.id), [a.id]);
  assert.equal(R.cancelReminder(b.id, ANA), null);
  assert.equal(R.cancelReminder(b.id, FELIPE).texto, 'vence depois');
  assert.deepEqual(R.getDueReminders(NOW + 3 * 86400).map((r) => r.id), [], 'bot ficou fora do ar por dias: descarta, nao spamma');
  assert.deepEqual(R.listReminders(FELIPE), []);
});

test('sendDueReminders: marca a pessoa, remove depois de enviar e mantem se falhar', async () => {
  reset();
  const real = Date.now;
  R.addReminder({ jid: FELIPE, nome: 'Felipe', groupJid: G, texto: 'comprar ingresso', em_minutos: 1 });
  R.addReminder({ jid: FELIPE, nome: 'Felipe', groupJid: G, texto: 'aviso do grupo', em_minutos: 1, para: 'grupo' });
  Date.now = () => real() + 120_000;
  try {
    const sent = [];
    let fail = true;
    const sock = { sendMessage: async (jid, content) => (fail && /ingresso/.test(content.text) ? Promise.reject(new Error('rede')) : (sent.push({ jid, content }), { key: { id: 'x' } })) };
    await sendDueReminders(sock);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content.text, '⏰ Lembrete: aviso do grupo');
    assert.equal(R.listReminders(FELIPE).length, 1, 'o que falhou continua pendente');
    fail = false;
    await sendDueReminders(sock);
    assert.deepEqual(sent[1].content.mentions, [FELIPE]);
    assert.match(sent[1].content.text, /^⏰ @5511111 lembrete: comprar ingresso$/);
    assert.equal(R.listReminders(FELIPE).length, 0);
  } finally {
    Date.now = real;
  }
});

test('funcoes da IA e comandos', async () => {
  reset();
  const ctx = { askerJid: FELIPE, askerName: 'Felipe', groupJid: G };
  const made = R.REMINDER_IMPLS.criar_lembrete({ texto: 'ligar pra mae', em_minutos: 30 }, ctx);
  assert.equal(made.criado, true);
  assert.equal(R.REMINDER_IMPLS.criar_lembrete({ texto: 'x', data: '2020-01-01', hora: '10:00' }, ctx).criado, false);
  assert.equal(R.REMINDER_IMPLS.listar_lembretes({}, ctx).lembretes.length, 1);
  assert.equal(R.REMINDER_IMPLS.cancelar_lembrete({ id: made.id }, { ...ctx, askerJid: ANA }).cancelado, false);

  const out = [];
  const sock = { sendMessage: async (_j, m) => out.push(m.text) };
  await commandLembretes({ sock, groupJid: G, senderJid: FELIPE });
  assert.match(out[0], new RegExp(`#${made.id} — .* — ligar pra mae`));
  await commandCancelarLembrete({ sock, groupJid: G, senderJid: FELIPE, args: `#${made.id}` });
  assert.match(out[1], /Cancelei/);
  await commandCancelarLembrete({ sock, groupJid: G, senderJid: FELIPE, args: 'abc' });
  assert.match(out[2], /Use:/);
  await commandLembretes({ sock, groupJid: G, senderJid: FELIPE });
  assert.match(out[3], /não tem lembretes/);
});

test('prompt do agente traz a hora e a tabela de dias da semana', async () => {
  let sys;
  const client = { chat: { completions: { create: async (req) => ((sys = req.messages[0].content), { choices: [{ message: { role: 'assistant', content: 'ok' } }] }) } } };
  await answerDataQuestion(client, G, 'oi', { asker: 'Felipe', askerJid: FELIPE });
  assert.match(sys, /agora sao \d{2}:\d{2} \(Brasilia\)/);
  assert.match(sys, /hoje (domingo|segunda-feira|terca-feira|quarta-feira|quinta-feira|sexta-feira|sabado) = \d{4}-\d{2}-\d{2}/);
  assert.match(sys, /amanha .* = \d{4}-\d{2}-\d{2}/);
  reset();
  for (const f of [process.env.AGENT_TRACES_FILE, process.env.AGENT_MEMORY_FILE]) fs.rmSync(f, { force: true });
});
