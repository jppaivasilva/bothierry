import test from 'node:test';
import assert from 'node:assert/strict';
import { isThanksToTarget, ThanksStreak, buildThanksText, pickThanksCount } from '../src/thanks.js';

const targets = ['5511999@s.whatsapp.net'];

test('agradecimento: marcando o alvo ou citando o nome', () => {
  assert.equal(isThanksToTarget({ text: 'Obrigado @5511999', mentionedJids: ['5511999@s.whatsapp.net'], targetJids: targets }), true);
  assert.equal(isThanksToTarget({ text: 'obrigada @5511999', mentionedJids: ['5511999:7@s.whatsapp.net'], targetJids: targets }), true, 'sufixo de dispositivo');
  assert.equal(isThanksToTarget({ text: 'Obrigadão Nicholas!', targetJids: targets }), true);
});

test('agradecimento: nao conta sem "obrigado" ou pra outra pessoa', () => {
  assert.equal(isThanksToTarget({ text: 'oi @5511999', mentionedJids: ['5511999@s.whatsapp.net'], targetJids: targets }), false);
  assert.equal(isThanksToTarget({ text: 'Obrigado @5522888', mentionedJids: ['5522888@s.whatsapp.net'], targetJids: targets }), false);
});

test('sequencia: dispara no terceiro, respeita cooldown e zera com outra mensagem', () => {
  const st = new ThanksStreak();
  let t = 1e9;
  assert.deepEqual([true, true, true].map((x) => st.register('g', x, (t += 1000))), [false, false, true]);
  assert.deepEqual([true, true, true].map((x) => st.register('g', x, (t += 1000))), [false, false, false], 'cooldown de 10 min');
  const st2 = new ThanksStreak();
  assert.deepEqual([true, true, false, true, true].map((x) => st2.register('g', x, (t += 1000))), [false, false, false, false, false]);
});

test('enxurrada: 8 a 12 mensagens, cada uma marcando o alvo', () => {
  for (let i = 0; i < 50; i++) {
    const n = pickThanksCount();
    assert.ok(n >= 8 && n <= 12);
  }
  assert.match(buildThanksText('5511999@s.whatsapp.net'), /^Obrigado @5511999/);
});
