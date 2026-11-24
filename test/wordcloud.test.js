import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWordCloud } from '../src/wordcloud.js';

test('nuvem: conta palavras e ignora links, comandos, risadas e palavras comuns', () => {
  const cloud = buildWordCloud([
    'kkkkk vamos jogar bola hoje, bola é vida',
    '!ranking',
    'olha https://globo.com/x isso é futebol',
    '@5511999999999 futebol amanhã? futebol',
    'rsrsrs aaaaa o jogo foi muito bom, jogo bom',
  ]);
  const count = (w) => cloud.words.find((x) => x.word === w)?.count;
  assert.equal(cloud.totalMessages, 4, 'o comando nao conta');
  assert.equal(count('futebol'), 3);
  assert.equal(count('bola'), 2);
  assert.equal(count('kkkkk'), undefined);
  assert.equal(count('globo'), undefined, 'o link some');
  assert.equal(count('que'), undefined);
});
