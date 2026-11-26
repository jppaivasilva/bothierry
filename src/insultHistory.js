// Historico PERMANENTE de insultos ao bot e expulsoes, por pessoa (insult_history.json,
// so na VM, entra no backup). Diferente do contador de strikes (insultos_state.json, que
// zera depois da expulsao) e do diario de acoes (que e podado): aqui nada se perde, pra
// responder "quantas vezes o Fulano ja foi expulso?" e montar o quadro !insultos.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatDisplayName } from './displayNames.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.INSULT_HISTORY_FILE || path.join(__dirname, '..', 'insult_history.json');
const MAX_TEXTS_PER_PERSON = 100;

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n) + '…' : String(s ?? ''));
const whenBR = (ts) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ts * 1000));

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    return { people: d.people && typeof d.people === 'object' ? d.people : {} };
  } catch {
    return { people: {} };
  }
}
function save(d) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 1));
  fs.renameSync(tmp, FILE);
}
function person(d, jid, nome) {
  const p = (d.people[jid] ||= { nome: '', totalInsultos: 0, insultos: [], expulsoes: [] });
  if (nome) p.nome = formatDisplayName(nome);
  return p;
}

/** Registra um insulto ao bot (strike = 1, 2 ou 3 no ciclo atual). Nunca lanca erro. */
export function recordInsult({ jid, nome, texto = '', strike = null, ts = Math.floor(Date.now() / 1000) }) {
  try {
    const d = load();
    const p = person(d, jid, nome);
    p.totalInsultos += 1;
    p.insultos.push({ ts, texto: clip(String(texto).replace(/@\d+/g, '').replace(/\s+/g, ' ').trim(), 140), strike });
    p.insultos = p.insultos.slice(-MAX_TEXTS_PER_PERSON);
    save(d);
  } catch (err) {
    console.error('Erro ao registrar insulto no historico:', err);
  }
}

/** Registra uma expulsao que o bot fez (so quando a remocao deu certo). */
export function recordExpulsion({ jid, nome, ts = Math.floor(Date.now() / 1000) }) {
  try {
    const d = load();
    person(d, jid, nome).expulsoes.push({ ts });
    save(d);
  } catch (err) {
    console.error('Erro ao registrar expulsao no historico:', err);
  }
}

function summarize(jid, p) {
  const last = p.insultos[p.insultos.length - 1];
  const lastExp = p.expulsoes[p.expulsoes.length - 1];
  return {
    jid,
    nome: p.nome || jid.split('@')[0],
    total_insultos: p.totalInsultos,
    vezes_expulso: p.expulsoes.length,
    ultimo_insulto: last ? { quando: whenBR(last.ts), texto: last.texto } : null,
    ultima_expulsao: lastExp ? whenBR(lastExp.ts) : null,
  };
}

/** Historico de quem bate com algum dos nomes (trecho, sem acento). */
export function findInsultStats(nomes) {
  const wanted = (nomes || []).map(norm).filter((n) => n.length >= 2);
  const d = load();
  return Object.entries(d.people)
    .filter(([, p]) => wanted.some((n) => norm(p.nome).includes(n)))
    .map(([jid, p]) => summarize(jid, p));
}

export const getInsultStatsByJid = (jid) => {
  const p = load().people[jid];
  return p ? summarize(jid, p) : null;
};

/** Quadro geral: quem mais insultou / foi expulso, e os totais. */
export function getInsultRanking(limit = 10) {
  const list = Object.entries(load().people).map(([jid, p]) => summarize(jid, p));
  list.sort((a, b) => b.vezes_expulso - a.vezes_expulso || b.total_insultos - a.total_insultos);
  return {
    pessoas: list.slice(0, limit),
    totais: { pessoas_com_insulto: list.length, insultos: list.reduce((s, x) => s + x.total_insultos, 0), expulsoes: list.reduce((s, x) => s + x.vezes_expulso, 0) },
  };
}

// ---------------- funcao que a IA pode chamar ----------------
export const INSULT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'historico_insultos',
      description: 'Historico permanente de insultos ao bot e de expulsoes: quantos insultos uma pessoa ja fez, quantas vezes foi expulsa, quando e o que disse. Sem "pessoa", devolve o quadro geral (ranking). Use pra "quantas vezes o Fulano ja foi removido?", "quem mais me xinga?".',
      parameters: { type: 'object', properties: { pessoa: { type: 'string', description: 'Nome ou apelido (opcional).' } } },
    },
  },
];

export function historicoInsultos({ pessoa }, resolveNames = (p) => [p]) {
  if (!pessoa) return getInsultRanking();
  const found = findInsultStats(resolveNames(pessoa));
  return found.length ? { pessoas: found } : { pessoas: [], aviso: 'nao tenho historico de insultos dessa pessoa (o historico so existe desde que foi criado; isso nao prova que nunca aconteceu)' };
}
