import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIRTHDAYS_FILE = path.join(__dirname, '..', 'birthdays.json');
const STATE_FILE = path.join(__dirname, '..', 'birthday_state.json');

function ensureBirthdaysFile() {
  if (!fs.existsSync(BIRTHDAYS_FILE)) fs.writeFileSync(BIRTHDAYS_FILE, '[]\n');
}

/**
 * Le a lista de aniversariantes de birthdays.json.
 * Cada entrada: { "name": "Fulano", "day": 15, "month": 4, "groupJid": "...opcional..." }
 * - day/month: numeros (1-31 / 1-12)
 * - groupJid e opcional: se informado, o aviso vai so pro grupo especificado;
 *   se omitido, vai pra todos os grupos que o numero do bot participa.
 */
export function loadBirthdays() {
  ensureBirthdaysFile();
  const content = fs.readFileSync(BIRTHDAYS_FILE, 'utf-8');
  if (!content.trim()) return [];
  return JSON.parse(content);
}

export function getBirthdaysToday(date = new Date()) {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  return loadBirthdays().filter((b) => b.day === day && b.month === month);
}

/**
 * Guarda/le a data (YYYY-MM-DD) do ultimo dia em que os avisos de aniversario
 * ja foram checados, pra nao mandar de novo no mesmo dia (ex: apos reiniciar
 * o bot varias vezes) nem depender do processo ficar sempre de pe pro cron rodar.
 */
function readState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

export function getLastBirthdayCheckDate() {
  return readState().lastCheckedDate || null;
}

export function setLastBirthdayCheckDate(dateStr) {
  writeState({ ...readState(), lastCheckedDate: dateStr });
}

/**
 * Grupos cujo nome foi trocado pra "Parabens" de um aniversariante e ainda
 * precisa ser revertido pro nome original — { [groupJid]: nomeOriginal }.
 * Guardado no mesmo arquivo de estado, sobrevive a reinicios do bot.
 */
export function getPendingGroupRenames() {
  return readState().pendingRenames || {};
}

export function setPendingGroupRenames(pendingRenames) {
  writeState({ ...readState(), pendingRenames });
}

/**
 * Data (YYYY-MM-DD) do ultimo dia em que o NOME do grupo ja foi sincronizado
 * com o aniversariante de hoje (ou revertido, se nao tiver aniversario) —
 * separado do "lastCheckedDate" (que e so sobre ja ter mandado a mensagem),
 * porque o nome precisa ser atualizado a meia-noite, antes do aviso de texto
 * (que continua saindo as 9h).
 */
export function getLastGroupNameSyncDate() {
  return readState().lastGroupNameSyncDate || null;
}

export function setLastGroupNameSyncDate(dateStr) {
  writeState({ ...readState(), lastGroupNameSyncDate: dateStr });
}
