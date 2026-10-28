import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULED_FILE = path.join(__dirname, '..', 'scheduled_messages.json');

function ensureFile() {
  if (!fs.existsSync(SCHEDULED_FILE)) fs.writeFileSync(SCHEDULED_FILE, '[]\n');
}

/**
 * Le as mensagens agendadas de scheduled_messages.json.
 * Cada entrada: { id, date: "YYYY-MM-DD", time: "HH:MM", text?, audio?: nome do
 * arquivo dentro de audios/, sent: bool }. "text" e "audio" sao opcionais, mas
 * pelo menos um dos dois deve existir pra mensagem fazer sentido.
 */
export function loadScheduledMessages() {
  ensureFile();
  const content = fs.readFileSync(SCHEDULED_FILE, 'utf-8');
  if (!content.trim()) return [];
  return JSON.parse(content);
}

function saveScheduledMessages(messages) {
  fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(messages, null, 2) + '\n');
}

/**
 * Retorna as mensagens agendadas ainda nao enviadas cuja data/hora ja chegou
 * (ou ja passou — funciona como "catch-up" se o bot estiver desligado na hora exata).
 */
export function getDueMessages(nowDate, nowTime) {
  return loadScheduledMessages().filter((m) => {
    if (m.sent) return false;
    return m.date < nowDate || (m.date === nowDate && m.time <= nowTime);
  });
}

export function markScheduledMessageSent(id) {
  const messages = loadScheduledMessages();
  const message = messages.find((m) => m.id === id);
  if (message) {
    message.sent = true;
    saveScheduledMessages(messages);
  }
}
