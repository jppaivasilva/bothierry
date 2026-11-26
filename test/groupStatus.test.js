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

test('foto: imageMessage fica no TOPO (sem embrulho V2), senao o Baileys perde o mediatype e o WhatsApp descarta', () => {
  const { message, additionalNodes } = buildGroupStatus({ content: { imageMessage: { url: 'u', mimetype: 'image/jpeg' }, caption: 'legenda' }, authorJid: AUTHOR, secret });
  assert.equal(message.groupStatusMessageV2, undefined);
  const img = message.imageMessage;
  assert.equal(img.caption, 'legenda');
  assert.equal(img.url, 'u');
  assert.equal(img.contextInfo.isGroupStatus, true);
  assert.deepEqual(img.contextInfo.statusAttributions, [{ type: 5, groupStatus: { authorJid: AUTHOR } }]);
  assert.equal(message.messageContextInfo.messageSecret, secret);
  assert.equal(additionalNodes.length, 1);
  assert.equal(buildGroupStatus({ content: { imageMessage: {} }, authorJid: AUTHOR, variant: 3, secret }).additionalNodes.length, 0);
  assert.equal(buildGroupStatus({ content: { imageMessage: {} }, authorJid: AUTHOR, variant: 2, secret }).message.imageMessage.contextInfo.statusAttributions, undefined);
});

test('foto: o Baileys enxerga o tipo de midia no topo da mensagem relayada', async () => {
  const calls = [];
  const sock = {
    user: { id: '5511999:12@s.whatsapp.net' },
    waUploadToServer: async () => ({ mediaUrl: 'https://x/y', directPath: '/d' }),
    relayMessage: async (...a) => calls.push(a),
  };
  // sem rede: prepareWAMessageMedia real faria upload; aqui so conferimos o formato com um imageMessage ja pronto
  const { message } = buildGroupStatus({ content: { imageMessage: { url: 'u' } }, authorJid: AUTHOR, secret });
  await sock.relayMessage('g@g.us', proto.Message.fromObject(message), { messageId: 'X', additionalNodes: [] });
  assert.ok(calls[0][1].imageMessage, 'mediatype=image sera marcado (getMediaType le message.imageMessage)');
  assert.equal(calls[0][1].groupStatusMessageV2, null);
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

function cmdEnv() {
  const out = [];
  const relayed = [];
  const sock = { user: { id: '1@s' }, sendMessage: async (jid, m) => (out.push(m.text), {}), relayMessage: async (...a) => relayed.push(a) };
  return { out, relayed, sock };
}
const asUser = (sock, senderJid, extra = {}) => ({ sock, groupJid: 'g@g.us', senderJid, senderName: 'Fulano', msg: { key: {} }, ...extra });

test('!statusgrupo em producao: qualquer membro posta texto; ajuda sem argumentos; texto grande recusado', async () => {
  delete process.env.GROUP_STATUS_ENABLED;
  delete process.env.STATUS_GRUPO_ONLY_ROOT;
  const { out, relayed, sock } = cmdEnv();
  await commandStatusGrupo({ ...asUser(sock, '5501@lid'), args: '' });
  assert.match(out[0], /Pra postar um \*status no grupo\*/);
  assert.equal(relayed.length, 0);
  await commandStatusGrupo({ ...asUser(sock, '5501@lid'), args: 'x'.repeat(301) });
  assert.match(out[1], /grande demais/);
  await commandStatusGrupo({ ...asUser(sock, '5501@lid'), args: 'bom dia grupo' });
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0][1].groupStatusMessageV2.message.extendedTextMessage.text, 'bom dia grupo');
  assert.match(out[2], /postei no status do grupo/);
});

test('!statusgrupo: limite de 1 por 5 min por pessoa (root sem limite) e variantes so pro root', async () => {
  const { out, relayed, sock } = cmdEnv();
  const user = asUser(sock, '5502@lid');
  await commandStatusGrupo({ ...user, args: 'primeiro' });
  await commandStatusGrupo({ ...user, args: 'segundo' });
  assert.equal(relayed.length, 1);
  assert.match(out[1], /um status por vez/);
  await commandStatusGrupo({ ...asUser(sock, '5503@lid'), args: '2 texto de outra pessoa' });
  assert.match(relayed[1][1].groupStatusMessageV2.message.extendedTextMessage.text, /^2 texto de outra pessoa$/, 'membro comum: o "2" e texto, nao variante');
  const root = asUser(sock, 'x@s', { msg: { key: { fromMe: true } } });
  await commandStatusGrupo({ ...root, args: 'a' });
  await commandStatusGrupo({ ...root, args: '3 b' });
  assert.equal(relayed.length, 4);
  assert.equal(relayed[3][2].additionalNodes.length, 0, 'variante 3 (sem no meta) so pro root');
});

test('!statusgrupo: ligar/desligar e restringir ao root pelo .env', async () => {
  const { out, relayed, sock } = cmdEnv();
  process.env.GROUP_STATUS_ENABLED = '0';
  await commandStatusGrupo({ ...asUser(sock, '5504@lid'), args: 'oi' });
  assert.match(out[0], /desligado/);
  delete process.env.GROUP_STATUS_ENABLED;
  process.env.STATUS_GRUPO_ONLY_ROOT = '1';
  await commandStatusGrupo({ ...asUser(sock, '5504@lid'), args: 'oi' });
  assert.match(out[1], /só pro root/);
  assert.equal(relayed.length, 0);
  delete process.env.STATUS_GRUPO_ONLY_ROOT;
});

test('!statusgrupo apagar: cada um apaga so o seu; root apaga o ultimo de qualquer um', async () => {
  const { out, relayed, sock } = cmdEnv();
  await commandStatusGrupo({ ...asUser(sock, '5510@lid'), args: 'do dez' });
  await commandStatusGrupo({ ...asUser(sock, '5511@lid'), args: 'do onze' });
  const n = relayed.length;
  await commandStatusGrupo({ ...asUser(sock, '5512@lid'), args: 'apagar' });
  assert.match(out.at(-1), /Não achei nenhum status seu/);
  assert.equal(relayed.length, n);
  await commandStatusGrupo({ ...asUser(sock, '5510@lid'), args: 'apagar' });
  assert.equal(relayed.length, n + 1);
  assert.equal(relayed.at(-1)[1].protocolMessage.type, proto.Message.ProtocolMessage.Type.REVOKE);
  assert.equal(relayed.at(-1)[2].additionalAttributes.edit, '7');
  assert.match(out.at(-1), /apagar o status/);
  await commandStatusGrupo({ ...asUser(sock, 'r@s', { msg: { key: { fromMe: true } } }), args: 'apagar' });
  assert.equal(relayed.length, n + 2, 'root apaga o ultimo de qualquer um (o do onze)');
  fs.rmSync(process.env.GROUP_STATUS_STATE_FILE, { force: true });
});

// ---------------- cartao automatico (previsao) ----------------
const { maybePostAutoStatus, autoStatusKinds } = await import('../src/bot/groupStatus.js');
const sharp = (await import('sharp')).default;

test('status automatico: previsao e aniversario por padrao; .env troca a lista; GROUP_STATUS_ENABLED=0 desliga', async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#3366cc' } }).png().toBuffer();
  const calls = [];
  const sock = { user: { id: '5511999:1@s.whatsapp.net' }, waUploadToServer: async () => ({ mediaUrl: 'https://mmg.whatsapp.net/x', directPath: '/v/x' }), relayMessage: async (...a) => calls.push(a) };
  delete process.env.GROUP_STATUS_ENABLED;
  delete process.env.GROUP_STATUS_AUTO;
  assert.deepEqual(autoStatusKinds(), ['previsao', 'aniversario'], 'padrao');
  const id = await maybePostAutoStatus(sock, 'g@g.us', 'previsao', { image: png, caption: 'Previsão do tempo — sexta' });
  assert.ok(id);
  const img = calls[0][1].imageMessage;
  assert.equal(img.caption, 'Previsão do tempo — sexta');
  assert.equal(img.contextInfo.isGroupStatus, true);
  assert.equal(calls[0][2].additionalNodes[0].attrs.origin, 'group_status');
  assert.ok(await maybePostAutoStatus(sock, 'g@g.us', 'aniversario', { image: png, caption: 'Hoje é aniversário!' }));
  assert.equal(await maybePostAutoStatus(sock, 'g@g.us', 'resumo', { image: png, caption: 'x' }), null, 'tipo fora da lista');
  assert.equal(await maybePostAutoStatus(sock, 'g@g.us', 'previsao', { image: null, caption: 'sem imagem' }), null);
  process.env.GROUP_STATUS_AUTO = 'aniversario';
  assert.equal(await maybePostAutoStatus(sock, 'g@g.us', 'previsao', { image: png, caption: 'x' }), null, 'lista do .env manda');
  process.env.GROUP_STATUS_AUTO = '';
  assert.deepEqual(autoStatusKinds(), [], 'vazio = nenhum');
  process.env.GROUP_STATUS_AUTO = 'previsao';
  process.env.GROUP_STATUS_ENABLED = '0';
  assert.equal(await maybePostAutoStatus(sock, 'g@g.us', 'previsao', { image: png, caption: 'x' }), null, 'desligado');
  assert.equal(calls.length, 2);
  delete process.env.GROUP_STATUS_ENABLED;
  delete process.env.GROUP_STATUS_AUTO;
  fs.rmSync(process.env.GROUP_STATUS_STATE_FILE, { force: true });
});

test('status automatico: se o WhatsApp recusar, nao lanca erro (o cartao normal ja saiu)', async () => {
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#000' } }).png().toBuffer();
  const sock = { user: { id: '5511999:1@s.whatsapp.net' }, waUploadToServer: async () => ({ mediaUrl: 'https://x', directPath: '/y' }), relayMessage: async () => Promise.reject(new Error('Connection Closed')) };
  process.env.GROUP_STATUS_AUTO = 'previsao';
  assert.equal(await maybePostAutoStatus(sock, 'g@g.us', 'previsao', { image: png, caption: 'x' }), null);
  assert.ok((await maybePostAutoStatus(sock, 'g@g.us', 'previsao', { image: png, caption: 'x' }, { force: true })) === null);
  delete process.env.GROUP_STATUS_ENABLED;
  delete process.env.GROUP_STATUS_AUTO;
  fs.rmSync(process.env.BOT_ACTIONS_FILE, { force: true });
});
