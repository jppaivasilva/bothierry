import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolFor, cotacao, previsao_tempo, LIVE_TOOLS, LIVE_IMPLS } from '../src/liveData.js';
import { answerDataQuestion } from '../src/dataQuestions.js';

test('symbolFor: nomes comuns, acoes brasileiras e americanas', () => {
  assert.equal(symbolFor('Dólar'), 'USDBRL=X');
  assert.equal(symbolFor('bitcoin'), 'BTC-USD');
  assert.equal(symbolFor('Ibovespa'), '^BVSP');
  assert.equal(symbolFor('petr4'), 'PETR4.SA');
  assert.equal(symbolFor('AAPL'), 'AAPL');
  assert.equal(symbolFor('banana frita'), null);
});

test('toda tool ao vivo tem implementacao', () => {
  for (const t of LIVE_TOOLS) assert.equal(typeof LIVE_IMPLS[t.function.name], 'function', t.function.name);
});

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}
const json = (obj) => ({ ok: true, status: 200, json: async () => obj });

test('cotacao: monta preco, variacao e horario a partir do Yahoo', async () => {
  const meta = { shortName: 'USD/BRL', currency: 'BRL', regularMarketPrice: 5.5, chartPreviousClose: 5.0, regularMarketTime: 1_760_000_000 };
  const out = await withFetch(async () => json({ chart: { result: [{ meta }] } }), () => cotacao({ ativo: 'euro' }));
  assert.equal(out.preco, 5.5);
  assert.equal(out.variacao_pct_vs_fechamento_anterior, 10);
  assert.ok(out.cotacao_em);
});

test('cotacao: falha da fonte vira { erro }, nunca um valor inventado', async () => {
  const out = await withFetch(async () => ({ ok: false, status: 500 }), () => cotacao({ ativo: 'ouro' }));
  assert.match(out.erro, /nao consegui/);
  assert.equal(out.preco, undefined);
});

test('previsao_tempo: cidade da tabela interna nao precisa de geocoding', async () => {
  const daily = { time: ['2026-11-25'], weathercode: [0], temperature_2m_max: [31.4], temperature_2m_min: [22.2], precipitation_probability_max: [10] };
  const out = await withFetch(async () => json({ daily }), () => previsao_tempo({ cidade: 'Santos', dias: 1 }));
  assert.equal(out.dias[0].maxima_c, 31);
  assert.equal(out.dias[0].chance_de_chuva_pct, 10);
});

test('answerDataQuestion: tool ao vivo assincrona entra no loop e o resultado volta pra IA', async () => {
  const calls = [];
  const client = {
    chat: {
      completions: {
        create: async (req) => {
          calls.push(req);
          if (calls.length === 1) {
            return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'cotacao', arguments: '{"ativo":"dolar"}' } }] } }] };
          }
          const toolMsg = req.messages.find((m) => m.role === 'tool');
          return { choices: [{ message: { role: 'assistant', content: `visto: ${toolMsg.content.includes('5.5') ? 'ok' : 'sem preco'}` } }] };
        },
      },
    },
  };
  const meta = { currency: 'BRL', regularMarketPrice: 5.5, chartPreviousClose: 5.5, regularMarketTime: 1_760_000_000 };
  const answer = await withFetch(async () => json({ chart: { result: [{ meta }] } }), () => answerDataQuestion(client, 'grupo@g.us', 'quanto ta o dolar?'));
  assert.equal(answer, 'visto: ok');
  assert.ok(calls[0].tools.some((t) => t.function.name === 'cotacao'));
});
