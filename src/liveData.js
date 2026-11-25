// Dados AO VIVO que o Bothierry pode consultar ao responder (so valores reais,
// nunca chute): cotacoes (Yahoo Finance), previsao do tempo (Open-Meteo) e
// noticias (feeds RSS). Cada funcao vira uma "tool" da IA
// (LIVE_TOOLS / LIVE_IMPLS) e, se a fonte falhar, devolve { erro } — a IA entao
// diz que nao conseguiu buscar agora, em vez de inventar.
import { describeWeatherCode } from './weather.js';
import { getRecentGameNews } from './gameNews.js';
import { getRecentHeadlines } from './news.js';

const UA = 'Mozilla/5.0 (compatible; BothierryBot/1.0)';
const TZ = 'America/Sao_Paulo';

const cache = new Map();
async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchJson(url, timeoutMs = 9000, extraHeaders = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'gzip', ...extraHeaders }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`status HTTP ${res.status}`);
  return res.json();
}

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const brTime = (sec) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }).format(new Date(sec * 1000));
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// ---------------- cotacoes ----------------
const ATIVOS = {
  dolar: 'USDBRL=X', 'dolar americano': 'USDBRL=X', usd: 'USDBRL=X', euro: 'EURBRL=X', eur: 'EURBRL=X', libra: 'GBPBRL=X',
  iene: 'JPYBRL=X', 'peso argentino': 'ARSBRL=X', bitcoin: 'BTC-USD', btc: 'BTC-USD', ethereum: 'ETH-USD', eth: 'ETH-USD',
  ibovespa: '^BVSP', bovespa: '^BVSP', ibov: '^BVSP', 'sp500': '^GSPC', 's&p 500': '^GSPC', 's&p500': '^GSPC', nasdaq: '^IXIC',
  'dow jones': '^DJI', ouro: 'GC=F', petroleo: 'CL=F', 'petroleo brent': 'BZ=F',
};

export function symbolFor(ativo) {
  const key = norm(ativo);
  if (ATIVOS[key]) return ATIVOS[key];
  const t = key.toUpperCase().replace(/\s+/g, '');
  if (/^[A-Z]{4}\d{1,2}$/.test(t)) return `${t}.SA`; // acao brasileira (PETR4, VALE3, ITUB4...)
  if (/^[A-Z]{1,5}$/.test(t)) return t; // acao americana (AAPL, TSLA...)
  return null;
}

async function yahooQuote(symbol) {
  return cached(`yf:${symbol}`, 60_000, async () => {
    const data = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || meta.regularMarketPrice == null) throw new Error('sem cotacao');
    return meta;
  });
}

export async function cotacao({ ativo }) {
  const symbol = symbolFor(ativo);
  if (!symbol) return { erro: `nao reconheci o ativo "${ativo}" (aceito: dolar, euro, libra, bitcoin, ethereum, ibovespa, sp500, nasdaq, ouro, petroleo ou codigo de acao como PETR4, VALE3, AAPL)` };
  try {
    const meta = await yahooQuote(symbol);
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    const out = {
      ativo: meta.shortName || meta.longName || symbol,
      simbolo: symbol,
      preco: round(meta.regularMarketPrice, meta.regularMarketPrice < 10 ? 4 : 2),
      moeda: meta.currency,
      variacao_pct_vs_fechamento_anterior: prev ? round(((meta.regularMarketPrice - prev) / prev) * 100) : null,
      cotacao_em: brTime(meta.regularMarketTime),
      fonte: 'Yahoo Finance (pode ter alguns minutos de atraso; fora do horario do pregao mostra o ultimo fechamento)',
    };
    if (symbol === 'BTC-USD' || symbol === 'ETH-USD') {
      try {
        const fx = await yahooQuote('USDBRL=X');
        out.preco_em_reais = round(meta.regularMarketPrice * fx.regularMarketPrice);
      } catch {
        // so em dolar
      }
    }
    return out;
  } catch (err) {
    return { erro: `nao consegui buscar a cotacao agora (${err.message})` };
  }
}

// ---------------- previsao do tempo ----------------
const CIDADES = {
  santos: [-23.9608, -46.3336], 'sao vicente': [-23.9631, -46.3919], cubatao: [-23.8953, -46.4253], 'praia grande': [-24.0058, -46.4025],
  guaruja: [-23.9931, -46.2564], 'sao paulo': [-23.5505, -46.6333], campinas: [-22.9099, -47.0626], tiete: [-23.1019, -47.7147],
  'rio de janeiro': [-22.9068, -43.1729], 'belo horizonte': [-19.9167, -43.9345], brasilia: [-15.7939, -47.8828], curitiba: [-25.4284, -49.2733],
  'porto alegre': [-30.0346, -51.2177], salvador: [-12.9714, -38.5014], recife: [-8.0476, -34.877], fortaleza: [-3.7319, -38.5267],
  florianopolis: [-27.5954, -48.548], goiania: [-16.6869, -49.2648], manaus: [-3.119, -60.0217], belem: [-1.4558, -48.4902],
  vitoria: [-20.3155, -40.3128], natal: [-5.7945, -35.211], 'joao pessoa': [-7.1195, -34.845], maceio: [-9.6498, -35.7089],
  aracaju: [-10.9472, -37.0731], 'sao luis': [-2.5307, -44.3068], teresina: [-5.0892, -42.8019], cuiaba: [-15.601, -56.0974],
  'campo grande': [-20.4697, -54.6201], palmas: [-10.1689, -48.3317], 'porto velho': [-8.7612, -63.9004], 'rio branco': [-9.9747, -67.8243],
  macapa: [0.0349, -51.0694], 'boa vista': [2.8235, -60.6758], ribeirao_preto: [-21.1775, -47.8103], 'ribeirao preto': [-21.1775, -47.8103],
  sorocaba: [-23.5015, -47.4526], 'sao jose dos campos': [-23.2237, -45.9009], londrina: [-23.3045, -51.1696], lisboa: [38.7223, -9.1393],
  'nova york': [40.7128, -74.006], miami: [25.7617, -80.1918], orlando: [28.5383, -81.3792], paris: [48.8566, 2.3522], londres: [51.5072, -0.1276],
};

async function findCity(nome) {
  const key = norm(nome);
  if (CIDADES[key]) return { nome, lat: CIDADES[key][0], lon: CIDADES[key][1] };
  const data = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(nome)}&count=1&language=pt`);
  const r = data?.results?.[0];
  return r ? { nome: [r.name, r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude } : null;
}

export async function previsao_tempo({ cidade, dias = 3 }) {
  try {
    const city = await findCity(cidade);
    if (!city) return { erro: `nao achei a cidade "${cidade}"` };
    const n = Math.min(Math.max(Number(dias) || 3, 1), 5);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode&timezone=${TZ}&forecast_days=${n}`;
    const data = await cached(`wx:${url}`, 10 * 60_000, () => fetchJson(url));
    const d = data.daily;
    return {
      cidade: city.nome,
      dias: d.time.map((date, i) => ({
        data: date,
        tempo: describeWeatherCode(d.weathercode[i]).desc,
        minima_c: Math.round(d.temperature_2m_min[i]),
        maxima_c: Math.round(d.temperature_2m_max[i]),
        chance_de_chuva_pct: d.precipitation_probability_max[i],
      })),
      fonte: 'Open-Meteo',
    };
  } catch (err) {
    return { erro: `nao consegui buscar a previsao agora (${err.message})` };
  }
}

// ---------------- futebol (football-data.org, chave gratis em FOOTBALL_DATA_API_KEY) ----------------
// O plano gratis cobre so estas competicoes (Copa do Brasil e Libertadores NAO).
const LIGAS = {
  brasileirao: 'BSA', premier_league: 'PL', la_liga: 'PD', serie_a_italia: 'SA', bundesliga: 'BL1', ligue_1: 'FL1',
  champions: 'CL', copa_do_mundo: 'WC', eurocopa: 'EC', eredivisie: 'DED', primeira_liga_portugal: 'PPL',
};
const STATUS = { FINISHED: 'encerrado', SCHEDULED: 'agendado', TIMED: 'agendado', IN_PLAY: 'em andamento', PAUSED: 'intervalo', POSTPONED: 'adiado', CANCELLED: 'cancelado', SUSPENDED: 'suspenso' };
const ymd = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms));

/** Converte a resposta da API em jogos legiveis (funcao pura, testavel). */
export function parseMatches(data, time = null) {
  const want = time ? norm(time) : null;
  return (data?.matches || [])
    .map((m) => {
      const score = m.score?.fullTime;
      const played = score && score.home != null && score.away != null;
      return {
        quando: brTime(Date.parse(m.utcDate) / 1000),
        status: STATUS[m.status] || m.status,
        rodada: m.matchday ?? undefined,
        jogo: played ? `${m.homeTeam.shortName || m.homeTeam.name} ${score.home} x ${score.away} ${m.awayTeam.shortName || m.awayTeam.name}` : `${m.homeTeam.shortName || m.homeTeam.name} x ${m.awayTeam.shortName || m.awayTeam.name}`,
        _names: norm(`${m.homeTeam.name} ${m.homeTeam.shortName} ${m.homeTeam.tla} ${m.awayTeam.name} ${m.awayTeam.shortName} ${m.awayTeam.tla}`),
        _t: Date.parse(m.utcDate),
      };
    })
    .filter((g) => !want || g._names.includes(want))
    .sort((a, b) => a._t - b._t);
}

/**
 * Entende o nome da liga que a IA mandou ("Brasileirão Série A", "campeonato brasileiro", "premier"...).
 * Devolve { code } ou { indisponivel } (Copa do Brasil, Libertadores... fora do plano gratis) ou null.
 */
export function resolveLiga(raw) {
  const n = norm(raw);
  if (!n) return { code: 'BSA' };
  if (/libertadores|sul.?americana|copa do brasil|carioca|paulista|mineiro|gaucho/.test(n)) return { indisponivel: true };
  const rules = [
    [/champions/, 'CL'], [/mundo|world cup|fifa/, 'WC'], [/eurocopa|euro 20|\beuro\b/, 'EC'],
    [/premier|ingl/, 'PL'], [/la ?liga|espanh|spain/, 'PD'], [/ital|calcio/, 'SA'], [/bundes|aleman|german/, 'BL1'],
    [/ligue|franc/, 'FL1'], [/eredivisie|holand|neerland/, 'DED'], [/portug|primeira liga/, 'PPL'],
    [/brasil|serie a|campeonato brasileiro|brasileir/, 'BSA'],
  ];
  for (const [re, code] of rules) if (re.test(n)) return { code };
  const exact = LIGAS[n.replace(/[\s-]+/g, '_')];
  return exact ? { code: exact } : null;
}

const pick = ({ quando, status, rodada, jogo }) => ({ quando, status, rodada, jogo });

export async function jogos_futebol({ liga = 'brasileirao', time = null, dias_atras = 5, dias_a_frente = 2 }) {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) return { erro: 'a consulta de futebol ainda nao esta configurada (falta a chave FOOTBALL_DATA_API_KEY no .env)' };
  const resolved = resolveLiga(liga);
  if (resolved?.indisponivel) return { erro: 'Copa do Brasil, Libertadores, Sul-Americana e estaduais nao estao na fonte gratuita de jogos — nao consigo consultar essas' };
  if (!resolved) return { erro: `nao reconheci a liga "${liga}" (disponiveis: ${Object.keys(LIGAS).join(', ')})` };
  const code = resolved.code;
  const headers = { 'X-Auth-Token': key };
  const back = Math.min(Math.max(Number(dias_atras) || 0, 0), 7);
  const fwd = Math.min(Math.max(Number(dias_a_frente) || 0, 0), 3);
  const from = ymd(Date.now() - back * 86400000);
  const to = ymd(Date.now() + fwd * 86400000);
  const base = `https://api.football-data.org/v4/competitions/${code}/matches`;
  try {
    const recent = await cached(`fd:${code}:${from}:${to}`, 5 * 60_000, () => fetchJson(`${base}?dateFrom=${from}&dateTo=${to}`, 9000, headers));
    const games = parseMatches(recent, time);
    if (!time) {
      if (games.length === 0) return { liga: code, jogos: [], aviso: 'nenhum jogo encontrado nesse periodo' };
      return { liga: code, jogos: games.slice(-14).map(pick), fonte: 'football-data.org' };
    }
    // Pergunta sobre um time: alem dos jogos recentes, traz os PROXIMOS (o calendario todo, nao so alguns dias a frente).
    const upcoming = await cached(`fd:${code}:agendados`, 30 * 60_000, () => fetchJson(`${base}?status=SCHEDULED,TIMED`, 12000, headers));
    const next = parseMatches(upcoming, time).slice(0, 3);
    const past = games.filter((g) => g.status !== 'agendado').slice(-4);
    if (past.length === 0 && next.length === 0) return { liga: code, time, jogos: [], aviso: 'nao achei jogos desse time nessa liga (confira o nome do time ou se ele joga outra competicao)' };
    return { liga: code, time, ultimos_jogos: past.map(pick), proximos_jogos: next.map(pick), fonte: 'football-data.org' };
  } catch (err) {
    return { erro: `nao consegui buscar os jogos agora (${err.message})` };
  }
}

// ---------------- noticias ----------------
export async function noticias({ assunto = 'games', quantidade = 5 }) {
  const n = Math.min(Math.max(Number(quantidade) || 5, 1), 8);
  try {
    if (norm(assunto).includes('game') || norm(assunto).includes('jogo')) {
      const items = await getRecentGameNews(n);
      return { assunto: 'games', noticias: items.map((i) => ({ titulo: i.title, fonte: i.source, quando: brTime(i.date / 1000), link: i.link })) };
    }
    const items = await getRecentHeadlines(n);
    return { assunto: 'geral (G1)', noticias: items.map((i) => ({ titulo: i.title, link: i.link })) };
  } catch (err) {
    return { erro: `nao consegui buscar as noticias agora (${err.message})` };
  }
}

// ---------------- definicoes pra IA ----------------
export const LIVE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'cotacao',
      description: 'Cotacao AGORA de dolar, euro, bitcoin, Ibovespa, S&P 500, ouro, petroleo ou de uma acao (ex: PETR4, VALE3, AAPL). So o preco de agora e a variacao do dia — nunca previsao.',
      parameters: { type: 'object', properties: { ativo: { type: 'string', description: 'Nome ou codigo: "dolar", "euro", "bitcoin", "ibovespa", "PETR4"...' } }, required: ['ativo'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'previsao_tempo',
      description: 'Previsao do tempo de uma cidade (hoje e proximos dias): condicao, minima, maxima e chance de chuva.',
      parameters: {
        type: 'object',
        properties: { cidade: { type: 'string', description: 'Nome da cidade (ex: "Santos", "Orlando").' }, dias: { type: 'integer', description: 'Quantos dias (1 a 5, padrao 3).' } },
        required: ['cidade'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'jogos_futebol',
      description: 'Placares, resultados e proximos jogos de futebol numa liga (Brasileirao, Premier League, La Liga, Serie A italiana, Bundesliga, Ligue 1, Champions, Copa do Mundo...), opcionalmente so de um time.',
      parameters: {
        type: 'object',
        properties: {
          liga: { type: 'string', description: `Uma de: ${Object.keys(LIGAS).join(', ')} (padrao brasileirao).` },
          time: { type: 'string', description: 'Nome do time pra filtrar (ex: "Palmeiras"). Omita pra ver a liga toda.' },
          dias_atras: { type: 'integer', description: 'Quantos dias pra tras olhar (padrao 5, max 7).' },
          dias_a_frente: { type: 'integer', description: 'Quantos dias pra frente olhar (padrao 2, max 3).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'noticias',
      description: 'Manchetes recentes: de games (IGN Brasil, Canaltech) ou noticias gerais (G1).',
      parameters: {
        type: 'object',
        properties: { assunto: { type: 'string', description: '"games" (padrao) ou "geral".' }, quantidade: { type: 'integer', description: 'Quantas manchetes (1 a 8, padrao 5).' } },
      },
    },
  },
];

export const LIVE_IMPLS = { cotacao, previsao_tempo, jogos_futebol, noticias };
