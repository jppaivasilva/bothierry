// Pessoas adicionadas na mao a lista de membros (admin, aba Membros) — quem faz
// aniversario ou aparece nos cartoes mas NAO esta no grupo (nunca mandou
// mensagem, entao o bot nao a conhece). Ganham jid proprio ("manual-<nome>"),
// foto editavel como qualquer membro e entram na ligacao de aniversarios.
// Ficam so na VM (extra_members.json, fora do git).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getMemberList, getMainGroupJid } from './db.js';
import { normalizeName, removeLinksToJid } from './birthdayLinks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'extra_members.json');

/** [{ jid, name }] */
export function loadExtraMembers() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    return Array.isArray(list) ? list.filter((e) => e && e.jid && e.name) : [];
  } catch {
    return [];
  }
}

function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2) + '\n');
}

/** Retorna { ok: true, member } ou { ok: false, error }. */
export function addExtraMember(rawName) {
  const name = String(rawName ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 40) return { ok: false, error: 'nome precisa ter de 2 a 40 letras' };
  const slug = normalizeName(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return { ok: false, error: 'nome inválido' };
  const jid = `manual-${slug}`;
  const list = loadExtraMembers();
  if (list.some((e) => e.jid === jid)) return { ok: false, error: 'essa pessoa já foi adicionada' };
  const member = { jid, name };
  list.push(member);
  save(list);
  return { ok: true, member };
}

/** Remove a pessoa e as ligacoes de aniversario que apontavam pra ela. A foto e apagada por quem chama. */
export function removeExtraMember(jid) {
  const list = loadExtraMembers();
  const next = list.filter((e) => e.jid !== jid);
  if (next.length === list.length) return false;
  save(next);
  removeLinksToJid(jid);
  return true;
}

/**
 * Membros do grupo principal (quem ja mandou mensagem) + as pessoas
 * adicionadas na mao. E a lista que o painel e os aniversarios usam.
 */
export function getMembersWithExtras() {
  const groupJid = getMainGroupJid();
  const real = groupJid ? getMemberList(groupJid) : [];
  const extras = loadExtraMembers().map((e) => ({ jid: e.jid, name: e.name, total: 0, todayCount: 0, since: null, manual: true }));
  return [...real, ...extras];
}
