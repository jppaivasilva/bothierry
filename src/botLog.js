// Diario das ACOES do bot (e do que acontece na administracao do grupo): avisos e
// expulsoes por insulto, regras avisadas, quem entrou/saiu/foi removido, mudancas
// do grupo. Sem isso o bot "nao lembra" do que ele mesmo fez (as mensagens dele nao
// entram no historico do grupo e o contador de insultos e apagado depois da
// expulsao) e responde "nao vi nada" sobre algo que ele proprio causou.
// Guardado em bot_actions.jsonl (so na VM, entra no backup). Alimenta o agente de
// dois jeitos: um resumo das ultimas acoes SEMPRE no prompt e a funcao acoes_do_bot.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.BOT_ACTIONS_FILE || path.join(__dirname, '..', 'bot_actions.jsonl');
const MAX_BYTES = 300 * 1024;

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n) + '…' : String(s ?? ''));

/** Registra uma acao. `resumo` e a frase pronta em portugues ("expulsei Fulano do grupo..."). Nunca lanca erro. */
export function logBotAction({ tipo, jid = null, nome = null, resumo, extra = null }) {
  try {
    try {
      if (fs.statSync(FILE).size > MAX_BYTES) {
        const keep = fs.readFileSync(FILE, 'utf-8').split('\n').filter(Boolean).slice(-300);
        fs.writeFileSync(FILE, keep.join('\n') + '\n');
      }
    } catch {
      // arquivo ainda nao existe
    }
    fs.appendFileSync(FILE, JSON.stringify({ ts: Math.floor(Date.now() / 1000), tipo, jid, nome, resumo: clip(resumo, 400), extra }) + '\n');
  } catch (err) {
    console.error('Erro ao registrar acao do bot:', err);
  }
}

function readAll() {
  try {
    return fs.readFileSync(FILE, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const whenBR = (ts) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ts * 1000));

/**
 * Acoes recentes, da mais nova pra mais antiga. Filtros: dias, tipo, e pessoa
 * (`nomes`: lista de nomes/apelidos aceitos, sem acento, por trecho).
 */
export function getRecentActions({ dias = 7, tipo = null, nomes = [], limit = 15 } = {}, nowSec = Math.floor(Date.now() / 1000)) {
  const since = nowSec - Math.min(Math.max(Number(dias) || 7, 1), 60) * 86400;
  const wanted = nomes.map(norm).filter((n) => n.length >= 2);
  return readAll()
    .filter((a) => a.ts >= since && (!tipo || a.tipo === tipo) && (wanted.length === 0 || wanted.some((n) => norm(a.nome).includes(n) || norm(a.resumo).includes(n))))
    .reverse()
    .slice(0, limit);
}

/** Linha legivel de uma acao. */
export const describeAction = (a) => `${whenBR(a.ts)} — ${a.resumo}`;

/** Bloco pro prompt: o que o bot fez/aconteceu no grupo nos ultimos dias (vazio se nada). */
export function buildRecentActionsContext({ horas = 72, limit = 10 } = {}, nowSec = Math.floor(Date.now() / 1000)) {
  const since = nowSec - horas * 3600;
  const list = readAll().filter((a) => a.ts >= since).slice(-limit);
  return list.map(describeAction).join('\n');
}

// ---------------- funcao que a IA pode chamar ----------------
export const BOT_LOG_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'acoes_do_bot',
      description:
        'Consulta o diario do que VOCE (o bot) fez e do que aconteceu na administracao do grupo: avisos e expulsoes por insulto (com o que a pessoa disse), regras avisadas, quem entrou, saiu ou foi removido, mudancas do grupo. Use SEMPRE que perguntarem "por que fulano saiu/foi removido/tomou aviso?", "o que voce fez?", "quem foi expulso?" etc.',
      parameters: {
        type: 'object',
        properties: {
          pessoa: { type: 'string', description: 'Nome ou apelido da pessoa (opcional).' },
          tipo: { type: 'string', enum: ['aviso_insulto', 'expulsao', 'regra', 'entrou', 'saiu', 'removido', 'grupo'], description: 'Tipo de acao (opcional).' },
          dias: { type: 'integer', description: 'Quantos dias olhar pra tras (padrao 7, max 60).' },
        },
      },
    },
  },
];

/** `resolveNames(pessoa)` devolve [apelido, nome completo, primeiro nome] (vem do apelidos.txt via quem_e). */
export function acoesDoBot({ pessoa, tipo, dias }, resolveNames = (p) => [p]) {
  const nomes = pessoa ? resolveNames(pessoa) : [];
  const list = getRecentActions({ dias, tipo, nomes });
  return list.length
    ? { acoes: list.map((a) => ({ quando: whenBR(a.ts), tipo: a.tipo, o_que_aconteceu: a.resumo })) }
    : { acoes: [], aviso: 'nao tenho nenhum registro disso no diario. Isso NAO prova que nao aconteceu (o diario so existe desde que foi criado) — diga que nao tem registro, nao que nao aconteceu.' };
}
