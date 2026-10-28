// Previsao do tempo via Open-Meteo (https://open-meteo.com) — gratuita, sem
// chave/login, usada na mensagem de bom dia.

// Coordenadas fixas das cidades acompanhadas — evita depender da API de
// geocodificacao (mais uma chamada, mais um ponto de falha) pra cidades que
// nunca mudam de lugar.
const CITIES = [
  { name: 'Santos', lat: -23.9608, lon: -46.3336 },
  { name: 'São Vicente', lat: -23.9631, lon: -46.3919 },
  { name: 'Cubatão', lat: -23.8953, lon: -46.4253 },
  { name: 'Praia Grande', lat: -24.0058, lon: -46.4025 },
  { name: 'São Paulo (Capital)', lat: -23.5505, lon: -46.6333 },
];

// Mapa simplificado dos codigos WMO (weathercode) que a Open-Meteo usa, pra
// um emoji + descricao curta em portugues. Nao cobre todo o espectro (seria
// uns 30 codigos), so os mais comuns — qualquer codigo fora da lista cai no
// "default" generico, sem quebrar nada.
const WEATHER_CODE_MAP = {
  0: { emoji: '☀️', desc: 'céu limpo' },
  1: { emoji: '🌤️', desc: 'poucas nuvens' },
  2: { emoji: '⛅', desc: 'parcialmente nublado' },
  3: { emoji: '☁️', desc: 'nublado' },
  45: { emoji: '🌫️', desc: 'neblina' },
  48: { emoji: '🌫️', desc: 'neblina com geada' },
  51: { emoji: '🌦️', desc: 'garoa fraca' },
  53: { emoji: '🌦️', desc: 'garoa' },
  55: { emoji: '🌧️', desc: 'garoa forte' },
  61: { emoji: '🌧️', desc: 'chuva fraca' },
  63: { emoji: '🌧️', desc: 'chuva' },
  65: { emoji: '⛈️', desc: 'chuva forte' },
  80: { emoji: '🌦️', desc: 'pancadas de chuva' },
  81: { emoji: '🌧️', desc: 'pancadas de chuva fortes' },
  82: { emoji: '⛈️', desc: 'pancadas de chuva muito fortes' },
  95: { emoji: '⛈️', desc: 'trovoada' },
  96: { emoji: '⛈️', desc: 'trovoada com granizo' },
  99: { emoji: '⛈️', desc: 'trovoada forte com granizo' },
};

function describeWeatherCode(code) {
  return WEATHER_CODE_MAP[code] || { emoji: '🌡️', desc: 'tempo variável' };
}

async function fetchCityForecast(city) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode` +
    `&timezone=America/Sao_Paulo&forecast_days=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`status HTTP ${res.status}`);
  const data = await res.json();

  const { emoji, desc } = describeWeatherCode(data.daily.weathercode[0]);
  return {
    name: city.name,
    emoji,
    desc,
    min: Math.round(data.daily.temperature_2m_min[0]),
    max: Math.round(data.daily.temperature_2m_max[0]),
    chuva: data.daily.precipitation_probability_max[0],
  };
}

/**
 * Busca a previsao do dia pra todas as cidades acompanhadas e monta um bloco
 * de texto pronto pra mandar no WhatsApp. Cidades que falharem (API fora do
 * ar, etc) sao puladas silenciosamente — o bloco sai com as que deram certo,
 * e so fica vazio (retorna null) se TODAS falharem.
 */
export async function getWeatherBlock() {
  const results = await Promise.allSettled(CITIES.map(fetchCityForecast));

  const linhas = results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value)
    .map((c) => `${c.emoji} *${c.name}*: ${c.min}°C - ${c.max}°C, ${c.desc}, ${c.chuva}% chance de chuva`);

  if (linhas.length === 0) return null;
  return `🌦️ *Previsão do tempo pra hoje:*\n${linhas.join('\n')}`;
}
