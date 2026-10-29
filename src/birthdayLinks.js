// Liga cada aniversariante (birthdays.json, que so tem o nome/apelido) a um
// membro do grupo — pra achar a foto de perfil dele pro cartao de aniversario.
//
// Ordem de decisao:
//  1) ligacao manual feita no painel (birthday_links.json) — sempre vence;
//  2) automatico: nome (ou apelido de apelidos.txt) igual ao nome de um membro,
//     mas SO se der exatamente uma pessoa (ex: "Daniel" bate com dois membros,
//     entao nao adivinha — sem foto ate alguem ligar na mao).
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

/**
 * Descobre o membro (jid) de um aniversariante. `members` = [{ jid, name }]
 * (getMemberList do db). Retorna { jid, source: 'manual' | 'auto' } ou null.
 */
export function resolveBirthdayMember(person, members) {
  const manual = loadBirthdayLinks()[normalizeName(person.name)];
  if (manual) return { jid: manual, source: 'manual' };

  const aliasMap = loadAliasMap();
  const candidates = new Set([normalizeName(person.name)]);
  const real = aliasMap[normalizeName(person.name)];
  if (real) candidates.add(normalizeName(real));

  const matches = members.filter((m) => {
    const raw = normalizeName(m.name);
    const pretty = normalizeName(formatDisplayName(m.name));
    return candidates.has(raw) || candidates.has(pretty);
  });
  return matches.length === 1 ? { jid: matches[0].jid, source: 'auto' } : null;
}
