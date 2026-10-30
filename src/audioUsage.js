// Conta quantas vezes cada audio salvo foi chamado (!nomedoaudio), pro "audio
// da semana" do resumo semanal. Arquivo so na VM (audio_usage.json, fora do
// git); guarda so os ultimos 30 dias de usos.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USAGE_FILE = path.join(__dirname, '..', 'audio_usage.json');
const KEEP_SECONDS = 30 * 24 * 60 * 60;

function load() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8')) || {};
  } catch {
    return {};
  }
}

/** Registra um uso do audio `name` agora. */
export function recordAudioUse(name) {
  const now = Math.floor(Date.now() / 1000);
  const usage = load();
  usage[name] = [...(usage[name] || []).filter((t) => t >= now - KEEP_SECONDS), now];
  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));
}

/** Audio mais usado desde `sinceTimestamp` (segundos): { name, count } ou null se nenhum foi usado. */
export function getTopAudioSince(sinceTimestamp) {
  let best = null;
  for (const [name, times] of Object.entries(load())) {
    const count = times.filter((t) => t >= sinceTimestamp).length;
    if (count > 0 && (!best || count > best.count)) best = { name, count };
  }
  return best;
}
