// Guarda a foto do grupo de ANTES do cartao de aniversario virar foto do grupo,
// pra devolver quando o aniversario passar. Fica so na VM (fotos de gente nao
// vao pro repositorio): group_photo_backup.json + group_photo_backups/.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'group_photo_backup.json');
const DIR = path.join(__dirname, '..', 'group_photo_backups');

const slug = (jid) => jid.replace(/[^a-z0-9]+/gi, '_');

/** { [groupJid]: { file: string|null, date: 'YYYY-MM-DD', urlKey: string|null } } */
export function loadBackups() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function saveBackups(all) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(all, null, 2) + '\n');
}

/** Guarda a foto original (Buffer, ou null se o grupo nao tinha foto) e a data em que o cartao entrou. */
export function saveBackup(groupJid, buffer, date) {
  const all = loadBackups();
  let file = null;
  if (buffer) {
    fs.mkdirSync(DIR, { recursive: true });
    file = `${slug(groupJid)}.jpg`;
    fs.writeFileSync(path.join(DIR, file), buffer);
  }
  all[groupJid] = { file, date, urlKey: null };
  saveBackups(all);
}

/** Marca de qual foto e a que o bot colocou (pra detectar se alguem trocou depois). */
export function setBackupUrlKey(groupJid, urlKey, date) {
  const all = loadBackups();
  if (!all[groupJid]) return;
  all[groupJid].urlKey = urlKey;
  all[groupJid].date = date;
  saveBackups(all);
}

export function readBackupBuffer(groupJid) {
  const entry = loadBackups()[groupJid];
  if (!entry?.file) return null;
  try {
    return fs.readFileSync(path.join(DIR, entry.file));
  } catch {
    return null;
  }
}

export function removeBackup(groupJid) {
  const all = loadBackups();
  const entry = all[groupJid];
  if (!entry) return;
  if (entry.file) fs.rmSync(path.join(DIR, entry.file), { force: true });
  delete all[groupJid];
  saveBackups(all);
}
