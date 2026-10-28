// Associa manualmente uma foto a uma pessoa do grupo, pelo nome — usado
// quando a foto de perfil via WhatsApp nao da (privacidade restrita) e
// alguem manda a foto por fora pra gente cadastrar na mao.
//
// Uso: node scripts/set-avatar.js "Nome Da Pessoa" caminho/da/foto.jpg
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findSenderJidByName, getGroupJidByName } from '../src/db.js';
import { getAvatarPath } from '../src/avatars.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALIASES_FILE = path.join(__dirname, '..', 'apelidos.txt');
const GROUP_NAME = 'FISCAIS™️';

function normalize(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Mesmo formato de apelidos.txt usado pelo !resumo/perguntas de dados:
// "Nome Completo;apelido1;apelido2" — usado aqui como fallback quando o
// nome passado nao bate literal com ninguem (ex: "Keijo" -> "André Augusto").
function resolveAlias(name) {
  if (!fs.existsSync(ALIASES_FILE)) return null;
  const target = normalize(name);
  for (const line of fs.readFileSync(ALIASES_FILE, 'utf-8').split('\n')) {
    const [realName, ...apelidos] = line.split(';').map((p) => p.trim());
    if (!realName) continue;
    if (apelidos.some((a) => a && normalize(a) === target)) return realName;
  }
  return null;
}

const [, , name, imagePath] = process.argv;
if (!name || !imagePath) {
  console.error('Uso: node scripts/set-avatar.js "Nome Da Pessoa" caminho/da/foto.jpg');
  process.exit(1);
}

if (!fs.existsSync(imagePath)) {
  console.error(`Arquivo nao encontrado: ${imagePath}`);
  process.exit(1);
}

const groupJid = getGroupJidByName(GROUP_NAME);
if (!groupJid) {
  console.error(`Grupo "${GROUP_NAME}" nao encontrado no historico de mensagens.`);
  process.exit(1);
}

let jid = findSenderJidByName(groupJid, name);
if (!jid) {
  const realName = resolveAlias(name);
  if (realName) jid = findSenderJidByName(groupJid, realName);
}
if (!jid) {
  console.error(`Nao achei (ou achei mais de uma pessoa parecida com) "${name}" no historico do grupo, nem como apelido em apelidos.txt.`);
  process.exit(1);
}

const destPath = getAvatarPath(jid);
fs.copyFileSync(imagePath, destPath);
console.log(`OK — foto de "${name}" (${jid}) salva em ${destPath}`);
