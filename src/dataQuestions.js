import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllRecordsForGroup } from './db.js';
import { formatDisplayName } from './displayNames.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALIASES_FILE = path.join(__dirname, '..', 'apelidos.txt');

const CHAT_MODEL = 'gpt-4o-mini';

// Brasil nao tem horario de verao desde 2019, entao o offset fixo -03:00 e seguro.
function brasiliaHour(timestamp) {
  const d = new Date(timestamp * 1000);
  return (d.getUTCHours() + 24 - 3) % 24;
}

function normalize(str) {
  return str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Le apelidos.txt — uma pessoa por linha, no formato
 * "Nome Completo Que Aparece No WhatsApp;apelido1;apelido2". Usado quando
 * alguem pergunta por um apelido que nao e um pedaco literal do nome real
 * (ex: "Tchongo"). Nao falha se o arquivo nao existir ou tiver linha mal
 * formatada — so ignora os apelidos.
 */
function loadAliases() {
  if (!fs.existsSync(ALIASES_FILE)) return {};
  const aliases = {};
  try {
    const lines = fs.readFileSync(ALIASES_FILE, 'utf-8').split('\n');
    for (const line of lines) {
      const parts = line.split(';').map((p) => p.trim());
      const [realName, ...apelidos] = parts;
      if (!realName) continue;
      for (const apelido of apelidos) {
        if (apelido) aliases[normalize(apelido)] = realName;
      }
    }
  } catch {
    return {};
  }
  return aliases;
}

function matchesName(senderName, query) {
  const a = normalize(senderName);
  const b = normalize(query);
  if (a.includes(b) || b.includes(a)) return true;

  const aliases = loadAliases();
  const aliasTarget = aliases[b];
  if (aliasTarget) {
    const c = normalize(aliasTarget);
    if (a.includes(c) || c.includes(a)) return true;
  }
  return false;
}

function inRange(dateStr, since, until) {
  if (since && dateStr < since) return false;
  if (until && dateStr > until) return false;
  return true;
}

// Agrupa registros por (data, remetente), somando so os que caem na janela de
// horario pedida (ou o dia inteiro, se apenasExpediente for false).
function buildDailyCounts(records, { apenasExpediente = false, since = null, ate = null } = {}) {
  const byDate = new Map(); // messageDate -> Map(senderName -> count)
  for (const r of records) {
    if (!inRange(r.messageDate, since, ate)) continue;
    if (apenasExpediente) {
      const h = brasiliaHour(r.timestamp);
      if (h < 8 || h >= 18) continue;
    }
    if (!byDate.has(r.messageDate)) byDate.set(r.messageDate, new Map());
    const m = byDate.get(r.messageDate);
    m.set(r.senderName, (m.get(r.senderName) || 0) + 1);
  }
  return byDate;
}

/**
 * Conta em quantos dias uma pessoa apareceu entre as top N (padrao 3) do
 * ranking de mensagens, opcionalmente restrito a expediente (08h-18h) e/ou a
 * partir de uma data.
 */
function contarTop3(records, { nome, posicao_maxima = 3, apenas_expediente = true, desde = null }) {
  const byDate = buildDailyCounts(records, { apenasExpediente: apenas_expediente, since: desde });
  let count = 0;
  const dias = [];
  for (const [date, counts] of byDate) {
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const topN = sorted.slice(0, posicao_maxima);
    const idx = topN.findIndex(([name]) => matchesName(name, nome));
    if (idx !== -1) {
      count++;
      dias.push({ data: date, posicao: idx + 1, mensagens: topN[idx][1] });
    }
  }
  return { pessoa: nome, posicao_maxima, apenas_expediente, desde, total_dias: count, dias };
}

/**
 * Soma o total de mensagens de uma pessoa (ou do grupo inteiro, se nome for
 * omitido), num periodo opcional, restrito a expediente ou nao.
 */
function totalMensagens(records, { nome = null, desde = null, ate = null, apenas_expediente = false } = {}) {
  let total = 0;
  for (const r of records) {
    if (!inRange(r.messageDate, desde, ate)) continue;
    if (apenas_expediente) {
      const h = brasiliaHour(r.timestamp);
      if (h < 8 || h >= 18) continue;
    }
    if (nome && !matchesName(r.senderName, nome)) continue;
    total++;
  }
  return { pessoa: nome, desde, ate, apenas_expediente, total };
}

// Teto de mensagens retornadas por listarMensagens — protege contra respostas
// gigantes (uma pessoa pode ter mandado centenas de mensagens num periodo
// longo) e contra gastar tokens demais na segunda chamada da IA.
const MAX_MENSAGENS_LISTADAS = 60;

function formatHoraBR(timestamp) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp * 1000));
}

/**
 * Lista as mensagens de texto de uma pessoa num periodo — usado quando a
 * pergunta pede o CONTEUDO das mensagens, nao so a contagem (ex: "quais
 * mensagens o Fulano mandou hoje"). Ignora mensagens sem texto (figurinha,
 * midia sem legenda, etc). Limita a MAX_MENSAGENS_LISTADAS, da mais recente
 * pra mais antiga, pra nao estourar o tamanho da resposta.
 */
function listarMensagens(records, { nome, desde = null, ate = null, apenas_expediente = false } = {}) {
  const daPessoa = records.filter((r) => {
    if (!inRange(r.messageDate, desde, ate)) return false;
    if (apenas_expediente) {
      const h = brasiliaHour(r.timestamp);
      if (h < 8 || h >= 18) return false;
    }
    return matchesName(r.senderName, nome);
  });

  const comTexto = daPessoa.filter((r) => r.text);
  const totalComTexto = comTexto.length;
  const ordenadas = comTexto.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_MENSAGENS_LISTADAS);
  const mensagens = ordenadas
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((r) => ({ data: r.messageDate, hora: formatHoraBR(r.timestamp), texto: r.text }));

  return {
    pessoa: nome,
    desde,
    ate,
    apenas_expediente,
    total_mensagens_no_periodo: daPessoa.length, // inclui figurinha/midia sem legenda
    total_mensagens_com_texto: totalComTexto, // so as que tem conteudo pra listar
    truncado: totalComTexto > MAX_MENSAGENS_LISTADAS,
    mensagens,
  };
}

/**
 * Ranking (top N) de mensagens num periodo opcional, restrito a expediente ou nao.
 */
function rankingPeriodo(records, { desde = null, ate = null, apenas_expediente = false, top = 10 } = {}) {
  const counts = new Map();
  for (const r of records) {
    if (!inRange(r.messageDate, desde, ate)) continue;
    if (apenas_expediente) {
      const h = brasiliaHour(r.timestamp);
      if (h < 8 || h >= 18) continue;
    }
    counts.set(r.senderName, (counts.get(r.senderName) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  return { desde, ate, apenas_expediente, ranking: sorted.map(([nome, mensagens], i) => ({ posicao: i + 1, nome: formatDisplayName(nome), mensagens })) };
}

/**
 * Resolve um apelido (cadastrado em apelidos.txt) pro nome de exibicao real
 * da pessoa no WhatsApp, e devolve tambem so o primeiro nome — usado quando
 * alguem pergunta "quem e o Fulano" se referindo a um apelido.
 */
function quemE(records, { apelido }) {
  const aliases = loadAliases();
  const nomeCompleto = aliases[normalize(apelido)];
  if (!nomeCompleto) {
    return { apelido, encontrado: false };
  }
  return { apelido, encontrado: true, nome_completo: nomeCompleto, primeiro_nome: nomeCompleto.trim().split(/\s+/)[0] };
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'contar_top3',
      description: 'Conta em quantos dias uma pessoa ficou entre as N (padrao 3) que mais mandaram mensagem no dia.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome (ou parte do nome) da pessoa.' },
          posicao_maxima: { type: 'integer', description: 'Top quantos considerar (padrao 3).' },
          apenas_expediente: { type: 'boolean', description: 'Se true (padrao), considera so mensagens das 08h as 18h.' },
          desde: { type: 'string', description: 'Data YYYY-MM-DD a partir da qual contar (opcional, padrao: desde o inicio do historico).' },
        },
        required: ['nome'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'total_mensagens',
      description:
        'Soma o total de mensagens de uma pessoa, ou do grupo inteiro se nome for omitido, num periodo opcional (incluindo um ' +
        'unico dia, passando a mesma data em desde e ate — ex: "quantas mensagens o grupo mandou ontem" usa so desde=ate=ontem, ' +
        'sem precisar de nome). Use esta funcao pra qualquer pergunta de "quantas mensagens" com ou sem pessoa especifica.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome (ou parte do nome) da pessoa. Omita pra somar o grupo inteiro.' },
          desde: { type: 'string', description: 'Data YYYY-MM-DD inicial (opcional). Pra um unico dia, use a mesma data em desde e ate.' },
          ate: { type: 'string', description: 'Data YYYY-MM-DD final (opcional).' },
          apenas_expediente: { type: 'boolean', description: 'Se true, considera so mensagens das 08h as 18h. Padrao false (dia inteiro).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ranking_periodo',
      description: 'Retorna o ranking (top N) de quem mais mandou mensagem num periodo opcional.',
      parameters: {
        type: 'object',
        properties: {
          desde: { type: 'string', description: 'Data YYYY-MM-DD inicial (opcional).' },
          ate: { type: 'string', description: 'Data YYYY-MM-DD final (opcional).' },
          apenas_expediente: { type: 'boolean', description: 'Se true, considera so mensagens das 08h as 18h. Padrao false.' },
          top: { type: 'integer', description: 'Quantas posicoes retornar (padrao 10).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_mensagens',
      description:
        'Lista o CONTEUDO (texto) das mensagens de uma pessoa num periodo, alem da contagem — use quando a pergunta pedir "quais ' +
        'mensagens", "o que ele(a) falou/mandou", "liste as mensagens", ou qualquer coisa que peca o conteudo real, nao so um ' +
        'numero. Tambem serve pra perguntas combinadas tipo "quantas e quais mensagens" (o resultado ja traz as duas coisas). ' +
        'Ignora figurinhas/midia sem legenda (nao tem texto pra mostrar) e limita a 60 mensagens mais recentes do periodo.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome (ou parte do nome, ou apelido) da pessoa.' },
          desde: { type: 'string', description: 'Data YYYY-MM-DD inicial (opcional). Pra um unico dia, use a mesma data em desde e ate.' },
          ate: { type: 'string', description: 'Data YYYY-MM-DD final (opcional).' },
          apenas_expediente: { type: 'boolean', description: 'Se true, considera so mensagens das 08h as 18h. Padrao false (dia inteiro).' },
        },
        required: ['nome'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'quem_e',
      description:
        'Resolve um apelido de alguem do grupo (cadastrado em apelidos.txt) pro nome real dessa pessoa — use quando a pergunta ' +
        'for do tipo "quem e o/a <apelido>". Nao serve pra perguntas sobre mensagens/estatisticas.',
      parameters: {
        type: 'object',
        properties: {
          apelido: { type: 'string', description: 'O apelido mencionado na pergunta.' },
        },
        required: ['apelido'],
      },
    },
  },
];

const TOOL_IMPLS = {
  contar_top3: contarTop3,
  total_mensagens: totalMensagens,
  ranking_periodo: rankingPeriodo,
  listar_mensagens: listarMensagens,
  quem_e: quemE,
};

// Datas de referencia (YYYY-MM-DD, fuso de Brasilia) calculadas em JS —
// calculadas aqui, nao pelo modelo: pedir pra IA fazer conta de "qual foi a
// segunda-feira mais recente" e coisas do tipo e nada confiavel na pratica
// (ela ja errou, usando um sabado como se fosse segunda). Por isso resolvemos
// as expressoes relativas mais comuns em datas prontas e so entregamos elas.
function getReferenceDates() {
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const [year, month, day] = todayStr.split('-').map(Number);
  const today = new Date(Date.UTC(year, month - 1, day));

  const weekday = today.getUTCDay(); // 0=domingo, 1=segunda, ..., 6=sabado
  const diffToMonday = weekday === 0 ? 6 : weekday - 1;
  const monday = new Date(today);
  monday.setUTCDate(monday.getUTCDate() - diffToMonday);

  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);

  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1));

  const fmt = (d) => d.toISOString().slice(0, 10);
  return {
    hoje: fmt(today),
    ontem: fmt(yesterday),
    inicio_desta_semana: fmt(monday),
    sete_dias_atras: fmt(sevenDaysAgo),
    inicio_deste_mes: fmt(firstOfMonth),
  };
}

function buildSystemPrompt() {
  const ref = getReferenceDates();
  return (
    `Datas de referencia (ja calculadas, horario de Brasilia — use estas exatamente, nunca calcule voce mesmo): ` +
    `hoje = ${ref.hoje}; ontem = ${ref.ontem}; inicio desta semana (segunda-feira) = ${ref.inicio_desta_semana}; ` +
    `7 dias atras = ${ref.sete_dias_atras}; inicio deste mes = ${ref.inicio_deste_mes}. ` +
    'Use essas datas prontas pra converter expressoes relativas na pergunta ("essa semana" = desde inicio desta semana ate hoje; ' +
    '"hoje" = so o dia hoje; "esse mes" = desde inicio deste mes ate hoje; "ultimos 7 dias" = desde 7 dias atras ate hoje) antes ' +
    'de chamar uma funcao. Nunca invente ou calcule uma data diferente das fornecidas aqui. ' +
    'Voce responde perguntas sobre estatisticas de mensagens de um grupo de WhatsApp, sobre o CONTEUDO das mensagens de alguem, ' +
    'e sobre quem e o dono de um apelido, em portugues do Brasil, SOMENTE usando as funcoes disponiveis (contar_top3, ' +
    'total_mensagens, ranking_periodo, listar_mensagens, quem_e). Se a pergunta pedir algo que nenhuma dessas funcoes calcula ' +
    '(ex: sentimento/analise subjetiva do conteudo, resumo, previsao, qualquer coisa fora de contagem/ranking/listagem de ' +
    'mensagens ou identificar apelido), responda diretamente (sem chamar funcao) com uma frase curta dizendo que ainda nao esta ' +
    'preparado pra esse tipo de pergunta. ' +
    'Quando a pergunta for "quem e o/a <apelido>", chame quem_e e responda so com o PRIMEIRO NOME da pessoa (o campo ' +
    'primeiro_nome do resultado), numa frase curta — nao repita o apelido nem de nomes completos. Se quem_e nao encontrar o ' +
    'apelido, diga que nao tem esse apelido cadastrado. ' +
    'Quando a pergunta pedir "quais mensagens"/"o que falou"/conteudo (combinada ou nao com "quantas"), chame listar_mensagens e ' +
    'responda com o total (campo total_mensagens_no_periodo) seguido de uma lista numerada "HH:MM — texto" com TODAS as ' +
    'mensagens do campo mensagens, uma por linha, na ordem que vierem — NUNCA resuma, corte ou escolha so algumas, mesmo que a ' +
    'lista seja longa; liste o array inteiro que a funcao devolveu. Se truncado for true, avise no final que so as mais ' +
    'recentes foram listadas (ja foi a propria funcao que cortou, nao corte de novo por cima). ' +
    'Pra qualquer outra pergunta (contagens/rankings), responda em 1-3 frases curtas e diretas, em portugues, com os numeros ' +
    'relevantes — sem inventar dados que a funcao nao retornou.'
  );
}

/**
 * Responde uma pergunta em linguagem natural sobre os dados do grupo, usando
 * function calling da OpenAI restrito a um conjunto fixo de consultas
 * (top3, total de mensagens, ranking). Fora desse escopo, a propria IA
 * responde que nao esta preparada, sem chamar nenhuma funcao.
 */
export async function answerDataQuestion(client, groupJid, question) {
  const records = getAllRecordsForGroup(groupJid);

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: question },
  ];

  const first = await client.chat.completions.create({
    model: CHAT_MODEL,
    messages,
    tools: TOOLS,
    tool_choice: 'auto',
    temperature: 0,
    max_tokens: 200,
  });

  const choice = first.choices[0];
  const toolCalls = choice.message.tool_calls;

  if (!toolCalls || toolCalls.length === 0) {
    return choice.message.content?.trim() || 'Ainda não estou preparado pra esse tipo de pergunta.';
  }

  messages.push(choice.message);
  for (const call of toolCalls) {
    const impl = TOOL_IMPLS[call.function.name];
    let result;
    try {
      const args = JSON.parse(call.function.arguments || '{}');
      result = impl ? impl(records, args) : { erro: 'funcao desconhecida' };
    } catch (err) {
      result = { erro: String(err) };
    }
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
  }

  const second = await client.chat.completions.create({
    model: CHAT_MODEL,
    messages,
    temperature: 0,
    // listar_mensagens pode trazer ate 60 mensagens pra IA reproduzir —
    // precisa de bem mais espaco que uma resposta curta de 1-3 frases.
    max_tokens: 3000,
  });

  return second.choices[0]?.message?.content?.trim() || 'Não consegui montar uma resposta com esses dados.';
}
