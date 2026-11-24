// Foto tematica do proprio bot (Natal, Carnaval, GTA VI...).

import path from 'path';
import { ROOT, getBrasiliaNow, getSharp } from './shared.js';
import fs from 'fs';

// Pasta com as fotos tematicas do bot (avatarbot/BoThierry_<Tema>.png) e
// arquivo que guarda qual tema esta valendo atualmente, pra so trocar a foto
// quando o tema mudar (evita reenviar a mesma foto toda vez que o cron roda).
const AVATAR_DIR = path.join(ROOT, 'avatarbot');

const AVATAR_STATE_FILE = path.join(ROOT, 'avatar_state.json');

const AVATAR_DEFAULT_FILE = 'BoThierry_Default.jpeg';

// Temas que vem junto com o repositorio (assets/themes/): usados quando o
// arquivo nao esta em avatarbot/ (que so existe na VM e nao vai pro git).
const BUNDLED_THEMES_DIR = path.join(ROOT, 'assets', 'themes');

// Algoritmo anonimo gregoriano pra calcular a data (UTC) do Domingo de Pascoa
// de um ano — usado pra derivar tambem o Carnaval, ja que ambos sao datas
// moveis (nao da pra so cravar dia/mes fixo como Natal ou Halloween).
function getEasterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function daysBetween(dateStr, referenceDate) {
  const target = new Date(`${dateStr}T00:00:00Z`);
  return Math.round((target - referenceDate) / 86400000);
}

// Ordem importa: a primeira que bater vence (evita, por ex., Pascoa e
// Carnaval se sobrepondo num ano estranho).
const AVATAR_THEMES = [
  // Lancamento do GTA VI (19/11/2026): do dia 18 ao 20.
  { name: 'GTAVI', file: 'BoThierry_GTAVI.jpg', matches: (month, day, dateStr) => dateStr >= '2026-11-18' && dateStr <= '2026-11-20' },
  {
    name: 'AnoNovo',
    file: 'BoThierry_AnoNovo.png',
    matches: (month, day) => (month === 12 && day >= 30) || (month === 1 && day <= 2),
  },
  { name: 'Natal', file: 'BoThierry_Natal.png', matches: (month, day) => month === 12 && day >= 23 && day <= 26 },
  { name: 'Halloween', file: 'BoThierry_Halloween.png', matches: (month, day) => month === 10 && day >= 29 && day <= 31 },
  { name: 'FestaJunina', file: 'BoThierry_FestaJunina.png', matches: (month, day) => month === 6 && day >= 20 && day <= 29 },
  {
    name: 'Carnaval',
    file: 'BoThierry_Carnaval.png',
    // Sabado de carnaval ate terca-feira (47 dias antes da Pascoa).
    matches: (month, day, dateStr) => {
      const carnavalTuesday = new Date(getEasterDate(Number(dateStr.slice(0, 4))).getTime() - 47 * 86400000);
      const diff = daysBetween(dateStr, carnavalTuesday);
      return diff >= -3 && diff <= 0;
    },
  },
  {
    name: 'Pascoa',
    file: 'BoThierry_Pascoa.png',
    // Sexta-feira Santa ate Domingo de Pascoa.
    matches: (month, day, dateStr) => {
      const diff = daysBetween(dateStr, getEasterDate(Number(dateStr.slice(0, 4))));
      return diff >= -2 && diff <= 0;
    },
  },
];

function getThemeForDate(dateStr) {
  const [, monthStr, dayStr] = dateStr.split('-');
  const month = Number(monthStr);
  const day = Number(dayStr);
  return AVATAR_THEMES.find((theme) => theme.matches(month, day, dateStr)) || null;
}

function getLastAvatarTheme() {
  if (!fs.existsSync(AVATAR_STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(AVATAR_STATE_FILE, 'utf-8')).theme || null;
  } catch {
    return null;
  }
}

function setLastAvatarTheme(themeName) {
  fs.writeFileSync(AVATAR_STATE_FILE, JSON.stringify({ theme: themeName }));
}

/**
 * Confere se hoje cai numa data tematica (Natal, Halloween, Carnaval, etc) e
 * troca a foto de perfil do PRÓPRIO BOT pra imagem correspondente em
 * avatarbot/ — volta pra BoThierry_Default.jpeg fora dessas datas. So troca
 * de fato quando o tema muda (idempotente entre chamadas do mesmo dia).
 */
export async function checkAndUpdateThemeAvatar(sock) {
  const { date: today } = getBrasiliaNow();
  const theme = getThemeForDate(today);
  const themeName = theme?.name || 'Default';

  if (getLastAvatarTheme() === themeName) return;

  const fileName = theme?.file || AVATAR_DEFAULT_FILE;
  const candidates = [path.join(AVATAR_DIR, fileName), path.join(BUNDLED_THEMES_DIR, fileName)];
  const filePath = candidates.find((f) => fs.existsSync(f));
  if (!filePath) return;

  try {
    const sharp = await getSharp();
    const buffer = await sharp(filePath).resize(640, 640, { fit: 'cover' }).jpeg().toBuffer();
    await sock.updateProfilePicture(sock.user.id, buffer);
    setLastAvatarTheme(themeName);
    console.log(`🖼️  Foto do bot trocada pro tema: ${themeName}`);
  } catch (err) {
    console.error(`Erro ao trocar foto do bot pro tema ${themeName}:`, err);
  }
}
