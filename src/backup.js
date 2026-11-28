// Backup noturno dos dados do bot (os arquivos que NAO estao no git): um
// .tar.gz por dia em backups/, guardando os 7 mais recentes. Se BACKUP_RCLONE_REMOTE
// estiver no .env (ex.: gdrive:bothierry-backups), tambem copia pra la com o rclone
// — assim sobra uma copia FORA da VM. Segredos (.env e auth_info/) ficam de FORA
// de proposito: dao acesso a conta/numero, e sao faceis de refazer (chaves e QR).
// No destino: diarios (15 dias), 1 completo por mes (pra sempre) e o historico de mensagens
// (archive/) copiado de forma incremental e permanente — ver os comentarios abaixo.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_LOCAL = 7;
const KEEP_REMOTE_DAYS = 15;

// Arquivos e pastas de dados (relativos a raiz do projeto). So entram os que existem.
const DATA_PATHS = [
  'messages.jsonl', 'archive', 'birthdays.json', 'birthday_links.json', 'birthday_photos', 'birthday_state.json',
  'member_photos', 'extra_members.json', 'events.json', 'audios', 'regras', 'avatarbot', 'avatars',
  'apelidos.txt', 'regulamento.txt', 'megasena.txt', 'scheduled_messages.json', 'audio_usage.json',
  'openai_usage.jsonl', 'agent_memory.json', 'reminders.json', 'bot_actions.jsonl', 'insult_history.json', 'news_sent.json', 'estreia_state.json', 'group_photo_backup.json', 'group_photo_backups',
  'avatar_state.json', 'insultos_state.json', 'eleicoes_state.json', 'news_state.json', 'metrics.jsonl',
];

const todayStamp = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

// Estrutura no destino (rclone), dentro de BACKUP_RCLONE_REMOTE:
//   bothierry-AAAA-MM-DD.tar.gz        backups diarios completos — apagados depois de KEEP_REMOTE_DAYS
//   mensais/bothierry-AAAA-MM.tar.gz   o 1o backup de cada mes — guardado PARA SEMPRE
//   historico/archive/messages-*.jsonl historico de mensagens (archive/) copiado de forma incremental
//                                      e NUNCA apagado (so cresce; ver syncHistorico)
const MONTHLY_DIR = 'mensais';
const HISTORY_DIR = 'historico/archive';

// Pasta que ainda nao existe no destino = lista vazia (nao e erro).
async function remoteList(exec, args) {
  try {
    const { stdout } = await exec('rclone', args, { timeout: 2 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    if (/not found|doesn't exist|does not exist/i.test(String(err.stderr || err.message))) return '';
    throw err;
  }
}

/**
 * Historico de mensagens (archive/) no destino, de forma incremental e a prova de perda: so envia arquivo
 * NOVO ou que CRESCEU (o arquivo do mes corrente recebe mensagens novas). Se um arquivo local estiver MENOR
 * que o do destino (sinal de truncamento/corrupcao), NAO envia e avisa — assim um problema local nunca
 * sobrescreve a copia boa. Nada e apagado no destino.
 */
export async function syncHistorico({ root, rcloneRemote, exec = run }) {
  const dir = path.join(root, 'archive');
  const out = { enviados: [], alertas: [], erros: [] };
  if (!fs.existsSync(dir)) return out;
  const remoteDir = `${rcloneRemote}/${HISTORY_DIR}`;
  const raw = await remoteList(exec, ['lsjson', '--files-only', remoteDir]);
  const remoteSizes = new Map((raw ? JSON.parse(raw) : []).map((f) => [f.Name, f.Size]));
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (!st.isFile()) continue;
    const remoteSize = remoteSizes.get(name);
    if (remoteSize !== undefined && st.size < remoteSize) {
      out.alertas.push(`${name}: local (${st.size} B) menor que o do destino (${remoteSize} B) — NAO enviado`);
      continue;
    }
    if (remoteSize === st.size) continue; // igual: nada a fazer
    try {
      await exec('rclone', ['copyto', full, `${remoteDir}/${name}`], { timeout: 10 * 60 * 1000 });
      out.enviados.push(name);
    } catch (err) {
      out.erros.push(`${name}: ${String(err.message || err).split('\n')[0]}`);
    }
  }
  return out;
}

/** Guarda o 1o backup de cada mes para sempre (mensais/bothierry-AAAA-MM.tar.gz). Devolve 'criado' ou 'ja_existia'. */
export async function ensureMonthlySnapshot({ file, rcloneRemote, month, exec = run }) {
  const name = `bothierry-${month}.tar.gz`;
  const listed = await remoteList(exec, ['lsf', '--files-only', `${rcloneRemote}/${MONTHLY_DIR}`]);
  if (listed.split('\n').map((l) => l.trim()).includes(name)) return 'ja_existia';
  await exec('rclone', ['copyto', file, `${rcloneRemote}/${MONTHLY_DIR}/${name}`], { timeout: 10 * 60 * 1000 });
  return 'criado';
}

/** Cria backups/bothierry-AAAA-MM-DD.tar.gz, apaga os mais velhos e (se configurado) copia pro rclone. */
export async function runBackup({ root = ROOT, rcloneRemote = process.env.BACKUP_RCLONE_REMOTE || '', exec = run } = {}) {
  const dir = path.join(root, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = todayStamp();
  const file = path.join(dir, `bothierry-${stamp}.tar.gz`);
  const present = DATA_PATHS.filter((p) => fs.existsSync(path.join(root, p)));
  if (present.length === 0) return { file: null, bytes: 0, remote: false, note: 'nenhum dado encontrado' };

  await exec('tar', ['-czf', file, '-C', root, ...present], { maxBuffer: 10 * 1024 * 1024 });
  const bytes = fs.statSync(file).size;

  const old = fs.readdirSync(dir).filter((f) => /^bothierry-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(f)).sort();
  for (const f of old.slice(0, -KEEP_LOCAL)) fs.rmSync(path.join(dir, f), { force: true });

  let remote = false;
  let remoteError = null;
  let monthly = null;
  let historico = null;
  if (rcloneRemote) {
    // 1) backup diario completo + limpeza dos antigos. A limpeza olha SO o nivel de cima e SO os diarios:
    //    mensais/ e historico/ ficam intocados (nunca sao apagados).
    try {
      await exec('rclone', ['copy', file, rcloneRemote], { timeout: 10 * 60 * 1000 });
      await exec('rclone', ['delete', rcloneRemote, '--min-age', `${KEEP_REMOTE_DAYS}d`, '--max-depth', '1', '--include', 'bothierry-*.tar.gz'], { timeout: 5 * 60 * 1000 });
      remote = true;
    } catch (err) {
      remoteError = String(err.message || err).split('\n')[0];
    }
    // 2) o 1o backup de cada mes, pra sempre. Falha aqui nao derruba o resto.
    try {
      monthly = await ensureMonthlySnapshot({ file, rcloneRemote, month: stamp.slice(0, 7), exec });
    } catch (err) {
      monthly = `erro: ${String(err.message || err).split('\n')[0]}`;
    }
    // 3) historico de mensagens (archive/), incremental e permanente.
    try {
      historico = await syncHistorico({ root, rcloneRemote, exec });
    } catch (err) {
      historico = { enviados: [], alertas: [], erros: [String(err.message || err).split('\n')[0]] };
    }
  }
  return { file, bytes, remote, remoteError, paths: present.length, monthly, historico };
}
