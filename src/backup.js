// Backup noturno dos dados do bot (os arquivos que NAO estao no git): um
// .tar.gz por dia em backups/, guardando os 7 mais recentes. Se BACKUP_RCLONE_REMOTE
// estiver no .env (ex.: gdrive:bothierry-backups), tambem copia pra la com o rclone
// — assim sobra uma copia FORA da VM. Segredos (.env e auth_info/) ficam de FORA
// de proposito: dao acesso a conta/numero, e sao faceis de refazer (chaves e QR).
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
  'openai_usage.jsonl', 'news_sent.json', 'estreia_state.json', 'group_photo_backup.json', 'group_photo_backups',
  'avatar_state.json', 'insultos_state.json', 'eleicoes_state.json', 'news_state.json', 'metrics.jsonl',
];

const todayStamp = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

/** Cria backups/bothierry-AAAA-MM-DD.tar.gz, apaga os mais velhos e (se configurado) copia pro rclone. */
export async function runBackup({ root = ROOT, rcloneRemote = process.env.BACKUP_RCLONE_REMOTE || '' } = {}) {
  const dir = path.join(root, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `bothierry-${todayStamp()}.tar.gz`);
  const present = DATA_PATHS.filter((p) => fs.existsSync(path.join(root, p)));
  if (present.length === 0) return { file: null, bytes: 0, remote: false, note: 'nenhum dado encontrado' };

  await run('tar', ['-czf', file, '-C', root, ...present], { maxBuffer: 10 * 1024 * 1024 });
  const bytes = fs.statSync(file).size;

  const old = fs.readdirSync(dir).filter((f) => /^bothierry-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(f)).sort();
  for (const f of old.slice(0, -KEEP_LOCAL)) fs.rmSync(path.join(dir, f), { force: true });

  let remote = false;
  let remoteError = null;
  if (rcloneRemote) {
    try {
      await run('rclone', ['copy', file, rcloneRemote], { timeout: 10 * 60 * 1000 });
      await run('rclone', ['delete', rcloneRemote, '--min-age', `${KEEP_REMOTE_DAYS}d`], { timeout: 5 * 60 * 1000 });
      remote = true;
    } catch (err) {
      remoteError = String(err.message || err).split('\n')[0];
    }
  }
  return { file, bytes, remote, remoteError, paths: present.length };
}
