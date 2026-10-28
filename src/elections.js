// Integracao com os dados oficiais de apuracao do TSE (resultados.tse.jus.br),
// publicados em arquivos .jws (JWS — JSON assinado, formato header.payload.assinatura,
// tudo em base64url). So decodificamos o payload pra leitura — nao verificamos a
// assinatura criptografica, o que e aceitavel aqui porque e so pra exibir os
// numeros num grupo de amigos, nao pra nenhuma decisao critica, e o transporte
// ja e HTTPS direto do dominio oficial do TSE.
//
// Codigos da eleicao de 2026:
// - 1o turno (04/10/2026): eleicao 6257 (presidente, cargo 1) / 6259 (governador, cargo 3)
// - 2o turno (25/10/2026): eleicao 6258, so presidente (cargo 1) — governador de SP
//   foi decidido no 1o turno (Tarcisio, 62,65%), entao nao tem corrida estadual hoje.
const PRESIDENT_URL = 'https://resultados.tse.jus.br/oficial/ele2026/6258/dados/br/br-c0001-e006258-u.jws';
const GOVERNOR_SP_URL = 'https://resultados.tse.jus.br/oficial/ele2026/6259/dados/sp/sp-c0003-e006259-u.jws';

function decodeJws(jwsText) {
  const payload = jwsText.split('.')[1];
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
}

async function fetchRaceData(url) {
  const res = await fetch(`${url}?nocache=${Date.now()}`);
  if (!res.ok) throw new Error(`status HTTP ${res.status}`);
  const text = await res.text();
  return decodeJws(text);
}

// Achata a estrutura aninhada do TSE (cargo -> federacao/agremiacao -> partido
// -> candidato) numa lista plana, ordenada do mais votado pro menos votado.
function extractCandidates(data) {
  const cargo = data.carg?.[0];
  if (!cargo) return [];
  const candidatos = [];
  for (const agr of cargo.agr || []) {
    for (const par of agr.par || []) {
      for (const cand of par.cand || []) {
        candidatos.push({
          nome: cand.nmu || cand.nm,
          numero: cand.n,
          partido: par.sg,
          votos: Number(cand.vap || 0),
          percentual: cand.pvap,
        });
      }
    }
  }
  return candidatos.sort((a, b) => b.votos - a.votos);
}

/**
 * Busca e resume a apuracao de uma corrida (presidente ou governador de um
 * estado) — percentual de urnas/secoes apuradas e o ranking de candidatos
 * por percentual de votos validos.
 */
export async function getRaceSummary(url) {
  const data = await fetchRaceData(url);
  const pst = data.s?.pst || '0,00';
  return {
    cargo: data.carg?.[0]?.nmn || null,
    atualizadoEm: data.ht,
    urnasPercentual: pst,
    urnasPercentualNum: parseFloat(pst.replace(',', '.')),
    secoesTotalizadas: data.s?.st,
    secoesTotal: data.s?.ts,
    candidatos: extractCandidates(data),
  };
}

export function getPresidentSummary() {
  return getRaceSummary(PRESIDENT_URL);
}

export function getGovernorSPSummary() {
  return getRaceSummary(GOVERNOR_SP_URL);
}

// As 5 regioes oficiais do IBGE, por UF — usado pra agrupar o percentual de
// urnas apuradas por regiao (o TSE so publica o dado bruto por estado, nao
// por regiao, entao agregamos aqui).
const REGIOES = {
  Norte: ['ac', 'ap', 'am', 'pa', 'ro', 'rr', 'to'],
  Nordeste: ['al', 'ba', 'ce', 'ma', 'pb', 'pe', 'pi', 'rn', 'se'],
  'Centro-Oeste': ['df', 'go', 'mt', 'ms'],
  Sudeste: ['es', 'mg', 'rj', 'sp'],
  Sul: ['pr', 'rs', 'sc'],
};

function presidentUrlForUf(uf) {
  return `https://resultados.tse.jus.br/oficial/ele2026/6258/dados/${uf}/${uf}-c0001-e006258-u.jws`;
}

/**
 * Busca, pra cada estado, quantas secoes foram totalizadas vs o total — e
 * agrega por regiao (soma bruta de secoes, nao media simples dos percentuais
 * de cada estado, pra nao dar peso igual a um estado pequeno e um grande).
 * Se algum estado falhar na busca, ele e ignorado no calculo da sua regiao
 * (log de erro, mas nao derruba o resto).
 */
export async function getUrnasApuradasPorRegiao() {
  const todasUfs = Object.values(REGIOES).flat();

  const resultadosPorUf = await Promise.all(
    todasUfs.map(async (uf) => {
      try {
        const data = await fetchRaceData(presidentUrlForUf(uf));
        return { uf, secoesTotalizadas: Number(data.s?.st || 0), secoesTotal: Number(data.s?.ts || 0) };
      } catch (err) {
        console.error(`[eleicoes] Erro ao buscar urnas apuradas do estado ${uf.toUpperCase()}:`, err.message);
        return null;
      }
    })
  );

  const porUf = new Map(resultadosPorUf.filter(Boolean).map((r) => [r.uf, r]));

  return Object.entries(REGIOES).map(([nome, ufs]) => {
    let secoesTotalizadas = 0;
    let secoesTotal = 0;
    for (const uf of ufs) {
      const r = porUf.get(uf);
      if (!r) continue;
      secoesTotalizadas += r.secoesTotalizadas;
      secoesTotal += r.secoesTotal;
    }
    const percentualNum = secoesTotal > 0 ? (secoesTotalizadas / secoesTotal) * 100 : 0;
    return {
      nome,
      percentual: percentualNum.toFixed(2).replace('.', ','),
      percentualNum,
    };
  });
}
