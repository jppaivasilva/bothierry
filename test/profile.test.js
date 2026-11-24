import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile } from '../src/profile.js';

const NOW = new Date('2026-11-20T15:00:00Z');
const row = (jid, name, date, hour, text = 'oi gente') => ({
  senderJid: jid, senderName: name, messageDate: date, text,
  timestamp: Math.floor(Date.UTC(...date.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))), hour + 3) / 1000),
});

test('perfil: numeros do ano, total de sempre, ultimos 60 dias e horas', () => {
  const rows = [
    row('a@s', 'Lucas Souza', '2026-11-19', 21, 'vamos de futebol hoje'), row('a@s', 'Lucas Souza', '2026-11-19', 22, 'futebol sempre'),
    row('a@s', 'Lucas Souza', '2026-11-20', 9), row('a@s', 'Lucas Souza', '2025-05-01', 12),
    row('b@s', 'Daniel Reinert', '2026-11-19', 10),
  ];
  const p = buildProfile(rows, 'a@s', NOW);
  assert.equal(p.year, 2026);
  assert.equal(p.stats.total, 3, 'so as de 2026');
  assert.equal(p.stats.rank, 1);
  assert.equal(p.totalAllTime, 4);
  assert.equal(p.firstDate, '2025-05-01');
  assert.equal(p.busiestDate, '2026-11-19');
  assert.equal(p.daily.length, 60);
  assert.equal(p.daily.at(-1).date, '2026-11-20');
  assert.equal(p.daily.at(-1).count, 1);
  assert.equal(p.perHour[21], 1);
  assert.equal(p.words[0].word, 'futebol');
});

test('perfil: pessoa sem mensagens ou so de anos anteriores', () => {
  assert.equal(buildProfile([row('b@s', 'Daniel', '2026-11-19', 10)], 'a@s', NOW), null);
  const old = buildProfile([row('a@s', 'Lucas Souza', '2025-05-01', 12)], 'a@s', NOW);
  assert.equal(old.stats, null, 'sem numeros de 2026');
  assert.equal(old.totalAllTime, 1);
});
