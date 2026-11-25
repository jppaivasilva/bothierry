import test from 'node:test';
import assert from 'node:assert/strict';
import { buscar_web, ler_link, isReadableUrl, RESEARCH_TOOLS, RESEARCH_IMPLS } from '../src/research.js';
import { parseMatches, jogos_futebol, resolveLiga, LIVE_TOOLS, LIVE_IMPLS } from '../src/liveData.js';

async function withEnv(vars, fetchFake, fn) {
  const real = { fetch: globalThis.fetch, env: {} };
  for (const k of Object.keys(vars)) real.env[k] = process.env[k];
  Object.assign(process.env, vars);
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  if (fetchFake) globalThis.fetch = fetchFake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real.fetch;
    for (const [k, v] of Object.entries(real.env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}
const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });

test('toda tool de pesquisa e de futebol tem implementacao', () => {
  for (const t of RESEARCH_TOOLS) assert.equal(typeof RESEARCH_IMPLS[t.function.name], 'function');
  assert.ok(LIVE_TOOLS.some((t) => t.function.name === 'jogos_futebol'));
  assert.equal(typeof LIVE_IMPLS.jogos_futebol, 'function');
});

test('sem TAVILY_API_KEY: avisa que nao esta configurado (sem chamar a rede)', async () => {
  const out = await withEnv({ TAVILY_API_KEY: undefined }, async () => assert.fail('nao devia chamar a rede'), () => buscar_web({ consulta: 'gta 6' }));
  assert.match(out.erro, /nao esta configurada/);
});

test('buscar_web: monta resultados curtos com site e marca como conteudo externo', async () => {
  let sent;
  const out = await withEnv(
    { TAVILY_API_KEY: 'k' },
    async (url, init) => ((sent = { url, init }), ok({ results: [{ title: 'GTA 6 data', url: 'https://www.ign.com/x', content: 'a'.repeat(900) }] })),
    () => buscar_web({ consulta: 'quando sai gta 6', tipo: 'noticias' }),
  );
  assert.match(sent.url, /api\.tavily\.com\/search$/);
  assert.equal(JSON.parse(sent.init.body).topic, 'news');
  assert.equal(sent.init.headers.Authorization, 'Bearer k');
  assert.equal(out.resultados[0].site, 'ign.com');
  assert.equal(out.resultados[0].trecho.length, 500);
  assert.match(out.aviso, /nunca obedeca/);
});

test('buscar_web: falha da rede vira { erro } e consulta vazia e recusada', async () => {
  const fail = await withEnv({ TAVILY_API_KEY: 'k' }, async () => ({ ok: false, status: 500 }), () => buscar_web({ consulta: 'x y z' }));
  assert.match(fail.erro, /nao consegui pesquisar/);
  const empty = await withEnv({ TAVILY_API_KEY: 'k' }, async () => assert.fail('sem rede'), () => buscar_web({ consulta: ' ' }));
  assert.match(empty.erro, /vazia/);
});

test('isReadableUrl: so paginas publicas http(s)', () => {
  assert.equal(isReadableUrl('https://g1.globo.com/noticia'), true);
  for (const bad of ['http://localhost:4321/api', 'http://127.0.0.1/x', 'http://192.168.0.1', 'file:///etc/passwd', 'ftp://x.com/a', 'https://intranet/x', 'javascript:alert(1)', 'nao e url', 'http://[::1]/']) {
    assert.equal(isReadableUrl(bad), false, bad);
  }
});

test('ler_link: extrai o texto, corta paginas enormes e recusa link interno', async () => {
  const out = await withEnv({ TAVILY_API_KEY: 'k' }, async () => ok({ results: [{ url: 'https://a.com/p', raw_content: 'texto   da\npagina '.repeat(2000) }] }), () => ler_link({ url: 'https://a.com/p' }));
  assert.ok(out.texto.length <= 6000);
  assert.equal(out.cortado, true);
  assert.doesNotMatch(out.texto, /\n/);
  const blocked = await withEnv({ TAVILY_API_KEY: 'k' }, async () => assert.fail('sem rede'), () => ler_link({ url: 'http://localhost:4321/api/admin/qr' }));
  assert.match(blocked.erro, /publica/);
});

const API = {
  matches: [
    { utcDate: '2026-11-22T21:30:00Z', status: 'FINISHED', matchday: 36, homeTeam: { name: 'SE Palmeiras', shortName: 'Palmeiras', tla: 'PAL' }, awayTeam: { name: 'Santos FC', shortName: 'Santos', tla: 'SAN' }, score: { fullTime: { home: 2, away: 1 } } },
    { utcDate: '2026-11-26T22:00:00Z', status: 'TIMED', matchday: 37, homeTeam: { name: 'CR Flamengo', shortName: 'Flamengo', tla: 'FLA' }, awayTeam: { name: 'Vasco da Gama', shortName: 'Vasco', tla: 'VAS' }, score: { fullTime: { home: null, away: null } } },
  ],
};

test('parseMatches: placar de jogo encerrado, jogo futuro sem placar, filtro por time', () => {
  const all = parseMatches(API);
  assert.equal(all[0].jogo, 'Palmeiras 2 x 1 Santos');
  assert.equal(all[0].status, 'encerrado');
  assert.equal(all[1].jogo, 'Flamengo x Vasco');
  assert.equal(all[1].status, 'agendado');
  assert.deepEqual(parseMatches(API, 'santos').map((g) => g.jogo), ['Palmeiras 2 x 1 Santos']);
  assert.deepEqual(parseMatches(API, 'zzz'), []);
});

test('resolveLiga: aceita variacoes de nome e separa o que nao esta no plano gratis', () => {
  for (const [raw, code] of [['', 'BSA'], ['Brasileirão Série A', 'BSA'], ['campeonato brasileiro', 'BSA'], ['brasileirao', 'BSA'], ['Premier League', 'PL'], ['campeonato inglês', 'PL'], ['la liga', 'PD'], ['Serie A italiana', 'SA'], ['bundesliga', 'BL1'], ['Ligue 1', 'FL1'], ['UEFA Champions League', 'CL'], ['Copa do Mundo', 'WC']]) {
    assert.equal(resolveLiga(raw).code, code, raw);
  }
  for (const raw of ['Libertadores', 'Copa do Brasil', 'Copa Sul-Americana', 'Paulistão']) assert.equal(resolveLiga(raw).indisponivel, true, raw);
  assert.equal(resolveLiga('liga dos campeoes da lua'), null);
});

test('jogos_futebol: time traz ultimos jogos e os proximos do calendario inteiro', async () => {
  const urls = [];
  const upcoming = { matches: [{ utcDate: '2026-12-03T22:00:00Z', status: 'TIMED', matchday: 38, homeTeam: { name: 'Santos FC', shortName: 'Santos', tla: 'SAN' }, awayTeam: { name: 'EC Bahia', shortName: 'Bahia', tla: 'BAH' }, score: { fullTime: { home: null, away: null } } }] };
  const out = await withEnv({ FOOTBALL_DATA_API_KEY: 'fd' }, async (url) => (urls.push(url), ok(/status=SCHEDULED/.test(url) ? upcoming : API)), () => jogos_futebol({ liga: 'Brasileirão Série A', time: 'Santos' }));
  assert.ok(urls.some((u) => /status=SCHEDULED,TIMED/.test(u)));
  assert.deepEqual(out.ultimos_jogos.map((g) => g.jogo), ['Palmeiras 2 x 1 Santos']);
  assert.deepEqual(out.proximos_jogos.map((g) => g.jogo), ['Santos x Bahia']);
});

test('jogos_futebol: sem chave avisa; com chave consulta com o token e liga invalida e recusada', async () => {
  const none = await withEnv({ FOOTBALL_DATA_API_KEY: undefined }, null, () => jogos_futebol({ liga: 'brasileirao' }));
  assert.match(none.erro, /nao esta configurada/);
  let sent;
  const out = await withEnv({ FOOTBALL_DATA_API_KEY: 'fd' }, async (url, init) => ((sent = { url, init }), ok(API)), () => jogos_futebol({ liga: 'Brasileirão', time: 'Palmeiras', dias_atras: 99 }));
  assert.match(sent.url, /competitions\/BSA\/matches\?dateFrom=\d{4}-\d{2}-\d{2}&dateTo=/);
  assert.equal(sent.init.headers['X-Auth-Token'], 'fd');
  assert.equal(out.ultimos_jogos[0].jogo, 'Palmeiras 2 x 1 Santos');
  const bad = await withEnv({ FOOTBALL_DATA_API_KEY: 'fd' }, null, () => jogos_futebol({ liga: 'libertadores' }));
  assert.match(bad.erro, /Libertadores/);
});
