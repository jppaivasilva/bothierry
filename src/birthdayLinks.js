// Liga cada aniversariante (birthdays.json, que so tem o nome/apelido) a um
// membro do grupo — pra achar a foto de perfil dele pro cartao de aniversario.
//
// Ordem de decisao:
//  1) ligacao manual feita no painel (birthday_links.json) — sempre vence;
//  2) automatico, so quando da EXATAMENTE uma pessoa (senao nao adivinha —
//     ex: "Daniel" bate com dois membros, fica sem foto ate alguem ligar na mao):
//       a) nome (ou apelido de apelidos.txt) igual ao nome do membro;
//       b) um nome "contem" o outro, palavra por palavra ("Lucas" ⊂ "Lucas
//          Souza", "Reinert" ⊂ "Daniel Reinert");
//  3) alem disso, o painel sugere candidatos (mesmo primeiro nome) pra ligar com um toque.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatDisplayName } from './displayNames.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LINKS_FILE = path.join(__dirname, '..', 'birthday_links.json');
const ALIASES_FILE = path.join(__dirname, '..', 'apelidos.txt');

export function normalizeName(str) {
  return String(str ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ligacoes manuais: { "<nome normalizado>": jid }. */
export function loadBirthdayLinks() {
  try {
    return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf-8')) || {};
  } catch {
    return {};
  }
}

/** Define (jid) ou remove (jid = null) a ligacao manual de um aniversariante. */
export function setBirthdayLink(name, jid) {
  const links = loadBirthdayLinks();
  const key = normalizeName(name);
  if (jid) links[key] = jid;
  else delete links[key];
  fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2) + '\n');
}

/** Remove todas as ligacoes manuais que apontam pra esse jid (ex.: pessoa manual removida). */
export function removeLinksToJid(jid) {
  const links = loadBirthdayLinks();
  let changed = false;
  for (const [key, value] of Object.entries(links)) {
    if (value === jid) {
      delete links[key];
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2) + '\n');
}

// apelidos.txt: "Nome Completo;apelido1;apelido2" -> { apelido normalizado: nome completo }
function loadAliasMap() {
  const map = {};
  try {
    for (const line of fs.readFileSync(ALIASES_FILE, 'utf-8').split('\n')) {
      const [realName, ...apelidos] = line.split(';').map((p) => p.trim());
      if (!realName) continue;
      for (const apelido of apelidos) if (apelido) map[normalizeName(apelido)] = realName;
    }
  } catch {
    // sem apelidos.txt — segue sem apelidos
  }
  return map;
}

// Palavras do nome, sem acento, ignorando particulas e letras soltas ("de", "da", "s"...).
const PARTICLES = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
function tokens(name) {
  return normalizeName(name)
    .split(' ')
    .filter((t) => t.length > 1 && !PARTICLES.has(t));
}

// Um conjunto de palavras contem o outro (em qualquer direcao)?
function oneContainsOther(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return false;
  const sub = (x, y) => [...x].every((t) => y.has(t));
  return sub(sa, sb) || sub(sb, sa);
}

/**
 * Descobre o membro (jid) de um aniversariante. `members` = [{ jid, name }]
 * (getMemberList do db). Retorna { jid, source: 'manual' | 'auto' } ou null.
 */
export function resolveBirthdayMember(person, members) {
  const manual = loadBirthdayLinks()[normalizeName(person.name)];
  if (manual) return { jid: manual, source: 'manual' };

  const aliasMap = loadAliasMap();
  const names = [person.name];
  const real = aliasMap[normalizeName(person.name)];
  if (real) names.push(real);
  const candidates = new Set(names.map(normalizeName));

  // a) nome igual (ou apelido)
  const exact = members.filter((m) => candidates.has(normalizeName(m.name)) || candidates.has(normalizeName(formatDisplayName(m.name))));
  if (exact.length === 1) return { jid: exact[0].jid, source: 'auto' };
  if (exact.length > 1) return null;

  // b) um nome contem o outro
  const partial = members.filter((m) =>
    names.some((n) => oneContainsOther(tokens(n), tokens(m.name)) || oneContainsOther(tokens(n), tokens(formatDisplayName(m.name)))),
  );
  return partial.length === 1 ? { jid: partial[0].jid, source: 'auto' } : null;
}

/**
 * Candidatos pra ligar na mao quando a regra automatica nao decidiu: membros
 * que dividem o primeiro nome (ou outra palavra) com o aniversariante.
 */
export function suggestBirthdayMembers(person, members, limit = 3) {
  const mine = new Set(tokens(person.name));
  const first = tokens(person.name)[0];
  return members
    .map((m) => {
      const mt = tokens(formatDisplayName(m.name));
      const shared = mt.filter((t) => mine.has(t)).length;
      const sameFirst = first && mt[0] === first ? 1 : 0;
      // Comeco de nome ("Geff" ~ "Gefferson", "Vini" ~ "Vinícius"): so sugere, nunca liga sozinho.
      const prefix = mt.some((t) => [...mine].some((x) => x.length >= 3 && t.length >= 3 && (t.startsWith(x) || x.startsWith(t)))) ? 1 : 0;
      return { m, score: shared * 2 + sameFirst + prefix };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ jid: x.m.jid, name: formatDisplayName(x.m.name) }));
}

/**
 * Nome que o sistema usa pra um aniversariante: o MESMO nome de exibicao do
 * membro no ranking/painel (ex.: "Lucas Souza", nao o apelido "Lucas") quando
 * ele esta ligado a um membro; sem ligacao (ex.: quem nao esta no grupo), o
 * nome como esta em birthdays.json.
 */
export function birthdayDisplayName(person, members) {
  const match = resolveBirthdayMember(person, members);
  const member = match ? members.find((m) => m.jid === match.jid) : null;
  return member ? formatDisplayName(member.name) : person.name;
}
