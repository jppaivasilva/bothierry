import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.GROUP_STATUS_STATE_FILE = path.join(os.tmpdir(), `bothierry-gs-${process.pid}.json`);
process.env.BOT_ACTIONS_FILE = path.join(os.tmpdir(), `bothierry-gs-actions-${process.pid}.jsonl`);
const { proto } = await import('@whiskeysockets/baileys');
const { buildGroupStatus, postGroupStatus, revokeGroupStatus, VARIANTS } = await import('../src/bot/groupStatus.js');
const { commandStatusGrupo } = await import('../src/bot/statusCommands.js');
const { isRoot } = await import('../src/bot/root.js');

const AUTHOR = '5511999@s.whatsapp.net';
const secret = Buffer.alloc(32, 7);

test('variante 1 (receita completa): V2 + isGroupStatus + atribuicao GROUP_STATUS + secret + no meta', () => {
  const { message, additionalNodes } = buildGroupStatus({ content: { text: 'oi grupo' }, authorJid: AUTHOR, variant: 1, secret });
  const ctx = message.groupStatusMessageV2.message.extendedTextMessage.contextInfo;
  assert.equal(ctx.isGroupStatus, true);
  assert.deepEqual(ctx.statusAttributions, [{ type: 5, groupStatus: { authorJid: AUTHOR } }]);
  assert.equal(message.messageContextInfo.messageSecret, secret);
  assert.deepEqual(additionalNodes, [{ tag: 'meta', attrs: { is_group_status: 'true', origin: 'group_status' } }]);
});

test('variantes 2 e 3 removem uma peca cada (pra descobrir qual o WhatsApp exige)', () => {
  const v2 = buildGroupStatus({ content: { text: 'x' }, authorJid: AUTHOR, variant: 2, secret });
  assert.equal(v2.message.groupStatusMessageV2.message.extendedTextMessage.contextInfo.statusAttributions, undefined);
  assert.equal(v2.additionalNodes.length, 1);
  const v3 = buildGroupStatus({ content: { text: 'x' }, authorJid: AUTHOR, variant: 3, secret });
  assert.ok(v3.message.groupStatusMessageV2.message.extendedTextMessage.contextInfo.statusAttributions);
  assert.deepEqual(v3.additionalNodes, []);
  assert.throws(() => buildGroupStatus({ content: { text: 'x' }, variant: 9 }), /variante invalida/);
  assert.equal(Object.keys(VARIANTS).length, 3);
});

test('imagem: legenda e contextInfo vao dentro da imageMessage', () => {
  const { message } = buildGroupStatus({ content: { imageMessage: { url: 'u', mimetype: 'image/jpeg' }, caption: 'legenda' }, authorJid: AUTHOR, secret });
  const img = message.groupStatusMessageV2.message.imageMessage;
  assert.equal(img.caption, 'legenda');
  assert.equal(img.contextInfo.isGroupStatus, true);
  assert.equal(img.url, 'u');
});

test('a mensagem montada e um protobuf valido do Baileys (codifica e decodifica sem perder os campos)', () => {
  const { message } = buildGroupStatus({ content: { text: 'oi' }, authorJid: AUTHOR, variant: 1, secret });
  const decoded = proto.Message.decode(proto.Message.encode(proto.Message.fromObject(message)).finish());
  const ctx = decoded.groupStatusMessageV2.message.extendedTextMessage.contextInfo;
  assert.equal(ctx.isGroupStatus, true);
  assert.equal(ctx.statusAttributions[0].type, proto.StatusAttribution.Type.GROUP_STATUS);
  assert.equal(ctx.statusAttributions[0].groupStatus.authorJid, AUTHOR);
  assert.equal(decoded.groupStatusMessageV2.message.extendedTextMessage.text, 'oi');
});

test('postGroupStatus envia por relayMessage com o no meta e devolve o id; revoke usa edit=7', async () => {
  const calls = [];
  const sock = { user: { id: '5511999:12@s.whatsapp.net' }, relayMessage: async (...a) => calls.push(a) };
  const { id } = await postGroupStatus(sock, 'g@g.us', { text: 'oi', variant: 1 });
  assert.equal(calls[0][0], 'g@g.us');
  assert.equal(calls[0][2].messageId, id);
  assert.equal(calls[0][2].additionalNodes[0].attrs.is_group_status, 'true');
  assert.equal(calls[0][1].groupStatusMessageV2.message.extendedTextMessage.contextInfo.statusAttributions[0].groupStatus.authorJid, AUTHOR);
  await revokeGroupStatus(sock, 'g@g.us', id);
  assert.equal(calls[1][2].additionalAttributes.edit, '7');
  assert.equal(calls[1][1].protocolMessage.key.id, id);
});

test('isRoot: so a conta do bot (fromMe) ou numero em ROOT_NUMBERS', () => {
  process.env.ROOT_NUMBERS = '5511999, 55 22 888';
  assert.equal(isRoot({ senderJid: '5511999@s.whatsapp.net', msg: { key: {} } }), true);
  assert.equal(isRoot({ senderJid: '552288@lid', msg: { key: {} } }), false);
  assert.equal(isRoot({ senderJid: '55 22 888@lid'.replace(/ /g, ''), msg: { key: {} } }), true);
  assert.equal(isRoot({ senderJid: 'x@s', msg: { key: { fromMe: true } } }), true);
  delete process.env.ROOT_NUMBERS;
  assert.equal(isRoot({ senderJid: '5511999@s.whatsapp.net', msg: { key: {} } }), false);
});

test('!statusgrupo: desligado por padrao; so root; mostra ajuda; nao posta sem permissao', async () => {
  const out = [];
  const dms = [];
  const relayed = [];
  const sock = { user: { id: '1@s' }, sendMessage: async (jid, m) => (jid.endsWith('@g.us') ? out.push(m.text) : dms.push([jid, m.text]), {}), relayMessage: async () => relayed.push(1) };
  const base = { sock, groupJid: 'g@g.us', senderJid: '5533777@lid', msg: { key: {} } };
  delete process.env.GROUP_STATUS_ENABLED;
  await commandStatusGrupo({ ...base, args: 'oi' });
  assert.match(out[0], /desligado/);
  process.env.GROUP_STATUS_ENABLED = '1';
  await commandStatusGrupo({ ...base, args: 'oi' });
  assert.match(out[1], /só pro root/);
  assert.match(dms[0][1], /ROOT_NUMBERS=5533777/, 'sem root configurado, manda no PRIVADO o numero a configurar');
  process.env.ROOT_NUMBERS = '5533777';
  await commandStatusGrupo({ ...base, args: '' });
  assert.match(out[2], /Use: \*!statusgrupo/);
  assert.equal(relayed.length, 0);
  await commandStatusGrupo({ ...base, args: '2 oi do teste' });
  assert.equal(relayed.length, 1);
  assert.match(out[3], /variante 2\) enviado/);
  await commandStatusGrupo({ ...base, args: 'apagar' });
  assert.equal(relayed.length, 2);
  delete process.env.ROOT_NUMBERS;
  delete process.env.GROUP_STATUS_ENABLED;
  for (const f of [process.env.GROUP_STATUS_STATE_FILE, process.env.BOT_ACTIONS_FILE]) fs.rmSync(f, { force: true });
});
