import test from 'node:test';
import assert from 'node:assert/strict';
import { computeWrapped, badgeForHour } from '../src/wrapped.js';

const rec = (jid, name, date, hour, text = 'oi gente') => ({
  senderJid: jid, senderName: name, messageDate: date, text,
  timestamp: Math.floor(Date.UTC(...date.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))), hour + 3) / 1000), // BRT = UTC-3
});

test('wrapped: totais, posicao, campeao do dia, sequencia e horario favorito', () => {
  const rows = [
    rec('a@s', 'Lucas Souza', '2026-11-01', 21), rec('a@s', 'Lucas Souza', '2026-11-01', 21), rec('a@s', 'Lucas Souza', '2026-11-02', 22),
    rec('b@s', 'Daniel Reinert', '2026-11-01', 9), rec('b@s', 'Daniel Reinert', '2026-11-05', 10),
    rec('a@s', 'Lucas Souza', '2025-12-31', 12), // outro ano: fora
  ];
  const w = computeWrapped(rows, 2026);
  assert.equal(w.group.total, 5);
  assert.equal(w.people.get('a@s').rank, 1);
  assert.equal(w.people.get('a@s').total, 3);
  assert.equal(w.people.get('a@s').streak, 2, 'dias 1 e 2 seguidos');
  assert.equal(w.people.get('a@s').championDays, 2);
  assert.equal(w.people.get('a@s').peakHour, 21);
  assert.equal(w.people.get('b@s').rank, 2);
  assert.equal(computeWrapped([], 2026), null);
});

test('wrapped: perfil pela hora', () => {
  assert.equal(badgeForHour(2).title, 'Coruja');
  assert.equal(badgeForHour(7).title, 'Madrugador');
  assert.equal(badgeForHour(14).title, 'Expediente');
  assert.equal(badgeForHour(21).title, 'Noturno');
});
