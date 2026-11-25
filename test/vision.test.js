import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.AGENT_TRACES_FILE = path.join(os.tmpdir(), `bothierry-vision-traces-${process.pid}.jsonl`);
process.env.AGENT_MEMORY_FILE = path.join(os.tmpdir(), `bothierry-vision-mem-${process.pid}.json`);
const { findImageMedia, toVisionDataUri, getImageForBot } = await import('../src/bot/vision.js');
const { answerDataQuestion } = await import('../src/dataQuestions.js');
const { getThreadMessages } = await import('../src/conversation.js');
const sharp = (await import('sharp')).default;

const key = { remoteJid: '1@g.us', id: 'M1', participant: '5511@s.whatsapp.net' };

test('findImageMedia: imagem da propria mensagem, citada, figurinha e nenhuma', () => {
  const own = { key, message: { imageMessage: { caption: '@bot o que e isso' } } };
  assert.equal(findImageMedia(own).target, own);
  const quoted = { key, message: { extendedTextMessage: { text: 'o que e isso?', contextInfo: { stanzaId: 'Q1', participant: '5522@s.whatsapp.net', quotedMessage: { imageMessage: {} } } } } };
  const f = findImageMedia(quoted);
  assert.equal(f.key, 'imageMessage');
  assert.equal(f.target.key.id, 'Q1');
  assert.equal(f.target.key.participant, '5522@s.whatsapp.net');
  const sticker = { key, message: { extendedTextMessage: { text: 'kkk', contextInfo: { stanzaId: 'S1', quotedMessage: { stickerMessage: {} } } } } };
  assert.equal(findImageMedia(sticker).key, 'stickerMessage');
  assert.equal(findImageMedia({ key, message: { conversation: 'oi' } }), null);
  assert.equal(findImageMedia({ key, message: { extendedTextMessage: { text: 'x', contextInfo: { quotedMessage: { conversation: 'so texto' } } } } }), null);
});

test('toVisionDataUri: reduz imagem grande pra no maximo 1024px em JPEG', async () => {
  const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#3366cc' } }).png().toBuffer();
  const uri = await toVisionDataUri(big);
  assert.match(uri, /^data:image\/jpeg;base64,/);
  const meta = await sharp(Buffer.from(uri.split(',')[1], 'base64')).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 1024);
  assert.equal(meta.height, 683);
});

test('toVisionDataUri: figurinha webp com transparencia vira JPEG com fundo branco', async () => {
  const webp = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).webp().toBuffer();
  const uri = await toVisionDataUri(webp);
  const px = await sharp(Buffer.from(uri.split(',')[1], 'base64')).raw().toBuffer();
  assert.ok(px[0] > 240 && px[1] > 240 && px[2] > 240, 'fundo transparente fica branco');
});

test('getImageForBot: sem imagem ou arquivo enorme devolve null sem baixar', async () => {
  assert.equal(await getImageForBot({ key, message: { conversation: 'oi' } }), null);
  assert.equal(await getImageForBot({ key, message: { imageMessage: { fileLength: 50 * 1024 * 1024 } } }), null);
});

test('agente: imagem vai como image_url na pergunta e a troca fica marcada na conversa', async () => {
  let sent;
  const client = { chat: { completions: { create: async (req) => ((sent = req), { choices: [{ message: { role: 'assistant', content: 'e um gato 🐱' } }] }) } } };
  const uri = 'data:image/jpeg;base64,AAAA';
  const answer = await answerDataQuestion(client, 'g@g.us', 'o que e isso?', { asker: 'Felipe', askerJid: '5511@s.whatsapp.net', image: uri });
  assert.equal(answer, 'e um gato 🐱');
  const user = sent.messages.at(-1).content;
  assert.equal(user[0].type, 'text');
  assert.match(user[0].text, /o que e isso\?/);
  assert.equal(user[1].image_url.url, uri);
  assert.match(getThreadMessages('g@g.us', '5511@s.whatsapp.net')[0].content, /mandei uma imagem/);
  assert.doesNotMatch(JSON.stringify(getThreadMessages('g@g.us', '5511@s.whatsapp.net')), /base64/, 'a imagem nao fica guardada');
});
