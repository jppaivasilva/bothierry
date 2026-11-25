// Memoria de longo prazo do agente: fatos leves que a pessoa conta sobre si
// (time do coracao, jogo favorito...) ou que pede pro bot anotar, mais fatos
// do grupo. Guardada em agent_memory.json (so na VM, no backup). Regras de
// privacidade ficam AQUI no codigo (nao so no prompt): nada sensivel, nada
// sobre OUTRA pessoa, limite de tamanho/quantidade, e cada um apaga os seus
// (!memoria / !esquecer). O conteudo e sempre tratado como DADO, nunca como
// instrucao pra IA.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatDisplayName } from './displayNames.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = process.env.AGENT_MEMORY_FILE || path.join(__dirname, '..', 'agent_memory.json');

export const MEMORY_LIMITS = { maxFactChars: 160, maxPerMember: 20, maxGroup: 30, promptMember: 12, promptGroup: 10 };

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    return { nextId: data.nextId || 1, facts: Array.isArray(data.facts) ? data.facts : [] };
  } catch {
    return { nextId: 1, facts: [] };
  }
}

function save(data) {
  const tmp = `${MEMORY_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, MEMORY_FILE);
}

// Assuntos que o bot nunca guarda, mesmo que peçam. Heuristica por palavra-chave:
// melhor recusar de mais do que guardar o que nao devia.
const SENSITIVE = [
  [/\b[\w.+-]+@[\w-]+\.[\w.]+/, 'e-mail'],
  [/(\+?\d[\s().-]?){9,}/, 'número (telefone/documento/cartão)'],
  [/\b(cpf|rg|cnpj|cnh|senha|password|token|pix|cartao|conta bancaria|agencia)\b/, 'dado pessoal/financeiro'],
  [/\b(moro (na|no|em)|meu endereco|minha casa fica|rua|avenida|cep)\b/, 'endereço'],
  [/\b(doenca|doente|depressao|ansiedade|cancer|hiv|remedio|medicacao|diagnostico|tratamento|terapia|psicolog\w*|psiquiatr\w*|gravid\w*|gravidez|aborto)\b/, 'saúde'],
  [/\b(gay|lesbica|bissexual|homossexual|transexual|orientacao sexual)\b/, 'orientação sexual'],
  [/\b(religiao|evangelic\w*|catolic\w*|ateu|espirita|umbanda|candomble|muculmano|judeu)\b/, 'religião'],
  [/\b(voto|votei|bolsonar\w*|lula|partido|eleitor|esquerdista|direitista)\b/, 'política'],
  [/\b(divida|dívida|devo (r\$|dinheiro)|salario|salário|emprestimo|falido|desempregado|demitido)\b/, 'dinheiro/emprego'],
];

/** Devolve o motivo se o texto nao pode ser guardado, ou null se pode. */
export function sensitiveReason(text) {
  const n = norm(text);
  for (const [re, why] of SENSITIVE) if (re.test(n)) return why;
  return null;
}

/**
 * Guarda um fato. scope 'member' = sobre quem pediu; 'group' = sobre o grupo.
 * Devolve { ok, fact } ou { ok:false, motivo }.
 */
export function addFact({ scope, jid, nome, texto, origem = 'auto' }) {
  const text = String(texto ?? '').replace(/\s+/g, ' ').trim().slice(0, MEMORY_LIMITS.maxFactChars);
  if (text.length < 3) return { ok: false, motivo: 'texto muito curto' };
  if (scope !== 'member' && scope !== 'group') return { ok: false, motivo: 'só guardo fatos sobre a própria pessoa ou sobre o grupo' };
  if (!jid) return { ok: false, motivo: 'não sei quem é a pessoa' };
  const why = sensitiveReason(text);
  if (why) return { ok: false, motivo: `não guardo coisas sobre ${why}` };

  const data = load();
  const mine = data.facts.filter((f) => (scope === 'member' ? f.scope === 'member' && f.jid === jid : f.scope === 'group'));
  if (mine.some((f) => norm(f.texto) === norm(text))) return { ok: true, fact: mine.find((f) => norm(f.texto) === norm(text)), duplicado: true };
  const cap = scope === 'member' ? MEMORY_LIMITS.maxPerMember : MEMORY_LIMITS.maxGroup;
  if (mine.length >= cap) return { ok: false, motivo: `a memória ${scope === 'member' ? 'dessa pessoa' : 'do grupo'} está cheia (apague algo com !esquecer)` };

  const fact = { id: data.nextId++, scope, jid, nome: formatDisplayName(nome || ''), texto: text, ts: Math.floor(Date.now() / 1000), origem };
  data.facts.push(fact);
  save(data);
  return { ok: true, fact };
}

export function listFacts({ jid }) {
  const data = load();
  return {
    mine: data.facts.filter((f) => f.scope === 'member' && f.jid === jid),
    group: data.facts.filter((f) => f.scope === 'group'),
  };
}

/** Fatos de uma pessoa pelo nome (parte do nome, sem acento). */
export function factsAbout(name) {
  const q = norm(name);
  if (q.length < 2) return [];
  return load().facts.filter((f) => f.scope === 'member' && norm(f.nome).includes(q));
}

/** Apaga um fato pelo numero (so o dono do fato). */
export function deleteFact(id, jid) {
  const data = load();
  const i = data.facts.findIndex((f) => f.id === Number(id) && f.jid === jid);
  if (i < 0) return null;
  const [removed] = data.facts.splice(i, 1);
  save(data);
  return removed;
}

/** Apaga os fatos da pessoa que contem o trecho (ex.: "esquece que meu time e o Santos"). */
export function deleteFactsMatching(jid, snippet) {
  const q = norm(snippet);
  if (q.length < 3) return [];
  const data = load();
  const removed = data.facts.filter((f) => f.jid === jid && norm(f.texto).includes(q));
  if (removed.length === 0) return [];
  data.facts = data.facts.filter((f) => !removed.includes(f));
  save(data);
  return removed;
}

/** Apaga tudo que a pessoa guardou (dela e os fatos de grupo que ela adicionou). */
export function deleteAllFor(jid) {
  const data = load();
  const before = data.facts.length;
  data.facts = data.facts.filter((f) => f.jid !== jid);
  if (data.facts.length !== before) save(data);
  return before - data.facts.length;
}

/** Bloco de memoria injetado no prompt (dado, nunca instrucao). Vazio se nao ha nada. */
export function buildMemoryContext({ jid, nome }) {
  const { mine, group } = listFacts({ jid });
  const lines = [];
  const recentMine = mine.slice(-MEMORY_LIMITS.promptMember);
  const recentGroup = group.slice(-MEMORY_LIMITS.promptGroup);
  if (recentMine.length) lines.push(`Sobre ${formatDisplayName(nome || 'quem esta falando')} (quem esta falando agora): ` + recentMine.map((f) => f.texto).join(' | '));
  if (recentGroup.length) lines.push('Sobre o grupo: ' + recentGroup.map((f) => f.texto).join(' | '));
  return lines.join('\n');
}

// ---------------- funcoes que a IA pode chamar ----------------
export const MEMORY_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'salvar_memoria',
      description:
        'Guarda um fato duradouro e leve pra lembrar depois. Use quando a pessoa pedir ("lembra que...", "anota ai") ou contar algo claro sobre SI MESMA (time, jogo/serie favorito, apelido que prefere). Nunca sobre outra pessoa; nunca saude, politica, religiao, dinheiro, endereco, documentos ou contatos.',
      parameters: {
        type: 'object',
        properties: {
          sobre: { type: 'string', enum: ['eu', 'grupo'], description: '"eu" = a pessoa que esta falando; "grupo" = algo do grupo todo.' },
          texto: { type: 'string', description: 'O fato, curto e objetivo, em terceira pessoa neutra (ex: "torce pro Santos").' },
          pedido: { type: 'boolean', description: 'true se a pessoa PEDIU pra guardar; false se voce decidiu guardar por conta propria.' },
        },
        required: ['sobre', 'texto'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_memoria',
      description: 'Procura o que o bot lembra sobre uma pessoa do grupo pelo nome (so o que ela mesma contou).',
      parameters: { type: 'object', properties: { pessoa: { type: 'string', description: 'Nome ou parte do nome.' } }, required: ['pessoa'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'esquecer_memoria',
      description: 'Apaga o que o bot guardou sobre quem esta falando, quando a pessoa pedir pra esquecer. So apaga fatos da propria pessoa.',
      parameters: { type: 'object', properties: { trecho: { type: 'string', description: 'Trecho do fato a esquecer (ex: "time").' } }, required: ['trecho'] },
    },
  },
];

export const MEMORY_IMPLS = {
  salvar_memoria: ({ sobre, texto, pedido }, ctx) => {
    const r = addFact({ scope: sobre === 'grupo' ? 'group' : sobre === 'eu' ? 'member' : sobre, jid: ctx.askerJid, nome: ctx.askerName, texto, origem: pedido ? 'pedido' : 'auto' });
    return r.ok ? { salvo: true, id: r.fact.id, texto: r.fact.texto, ja_existia: r.duplicado || undefined } : { salvo: false, motivo: r.motivo };
  },
  consultar_memoria: ({ pessoa }) => {
    const facts = factsAbout(pessoa);
    return facts.length ? { pessoa, fatos: facts.map((f) => `${f.nome}: ${f.texto}`) } : { pessoa, fatos: [], aviso: 'nao tenho nada guardado sobre essa pessoa' };
  },
  esquecer_memoria: ({ trecho }, ctx) => {
    const removed = deleteFactsMatching(ctx.askerJid, trecho);
    return removed.length ? { apagados: removed.map((f) => f.texto) } : { apagados: [], aviso: 'nao achei nada seu com esse trecho' };
  },
};
