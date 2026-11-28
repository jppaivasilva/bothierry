import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { runBackup, syncHistorico, ensureMonthlySnapshot } from '../src/backup.js';

const real = promisify(execFile);

// Drive de mentira: guarda o que seria copiado e responde como o rclone. tar roda de verdade.
function fakeDrive() {
  const files = new Map(); // caminho no destino -> tamanho
  const calls = [];
  const notFound = () => Object.assign(new Error('directory not found'), { stderr: 'Failed: directory not found' });
  const exec = async (cmd, args, opts) => {
    if (cmd !== 'rclone') return real(cmd, args, opts);
    calls.push(args);
    const [op] = args;
    if (op === 'copy') {
      files.set(`${args[2]}/${path.basename(args[1])}`, fs.statSync(args[1]).size);
      return { stdout: '' };
    }
    if (op === 'copyto') {
      files.set(args[2], fs.statSync(args[1]).size);
      return { stdout: '' };
    }
    if (op === 'delete') return { stdout: '' };
    if (op === 'lsjson' || op === 'lsf') {
      const dir = args[2];
      const inside = [...files].filter(([p]) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'));
      if (inside.length === 0) throw notFound();
      return { stdout: op === 'lsf' ? inside.map(([p]) => p.slice(dir.length + 1)).join('\n') : JSON.stringify(inside.map(([p, size]) => ({ Name: p.slice(dir.length + 1), Size: size }))) };
    }
    throw new Error(`rclone ${op} inesperado`);
  };
  return { files, calls, exec };
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bothierry-backup-'));
  fs.mkdirSync(path.join(root, 'archive'));
  fs.writeFileSync(path.join(root, 'archive', 'messages-2026-09.jsonl'), 'a'.repeat(1000));
  fs.writeFileSync(path.join(root, 'archive', 'messages-2026-10.jsonl'), 'b'.repeat(2000));
  fs.writeFileSync(path.join(root, 'events.json'), '[]');
  return root;
}
const R = 'gdrive:bothierry-backups';

test('1o backup: diario + mensal + historico; a limpeza so mexe nos diarios do nivel de cima', async () => {
  const root = makeRoot();
  const d = fakeDrive();
  const out = await runBackup({ root, rcloneRemote: R, exec: d.exec });
  assert.equal(out.remote, true);
  assert.equal(out.monthly, 'criado');
  assert.deepEqual(out.historico.enviados, ['messages-2026-09.jsonl', 'messages-2026-10.jsonl']);
  const names = [...d.files.keys()];
  assert.ok(names.some((n) => /^gdrive:bothierry-backups\/bothierry-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(n)), 'diario');
  assert.ok(names.some((n) => /\/mensais\/bothierry-\d{4}-\d{2}\.tar\.gz$/.test(n)), 'mensal');
  assert.ok(names.includes(`${R}/historico/archive/messages-2026-10.jsonl`), 'historico');
  const del = d.calls.find((c) => c[0] === 'delete');
  assert.deepEqual(del, ['delete', R, '--min-age', '15d', '--max-depth', '1', '--include', 'bothierry-*.tar.gz']);
});

test('2o backup no mesmo mes: nao repete o mensal nem reenvia historico que nao mudou', async () => {
  const root = makeRoot();
  const d = fakeDrive();
  await runBackup({ root, rcloneRemote: R, exec: d.exec });
  const copytoAntes = d.calls.filter((c) => c[0] === 'copyto').length;
  const out = await runBackup({ root, rcloneRemote: R, exec: d.exec });
  assert.equal(out.monthly, 'ja_existia');
  assert.deepEqual(out.historico.enviados, []);
  assert.equal(d.calls.filter((c) => c[0] === 'copyto').length, copytoAntes, 'nenhum copyto novo');
});

test('historico: arquivo que CRESCEU e reenviado; arquivo MENOR (corrompido) NAO sobrescreve a copia boa', async () => {
  const root = makeRoot();
  const d = fakeDrive();
  await syncHistorico({ root, rcloneRemote: R, exec: d.exec });
  fs.appendFileSync(path.join(root, 'archive', 'messages-2026-10.jsonl'), 'c'.repeat(500)); // mes corrente recebeu mensagens
  fs.writeFileSync(path.join(root, 'archive', 'messages-2026-09.jsonl'), 'a'.repeat(10)); // truncado!
  const out = await syncHistorico({ root, rcloneRemote: R, exec: d.exec });
  assert.deepEqual(out.enviados, ['messages-2026-10.jsonl']);
  assert.equal(d.files.get(`${R}/historico/archive/messages-2026-10.jsonl`), 2500);
  assert.equal(d.files.get(`${R}/historico/archive/messages-2026-09.jsonl`), 1000, 'a copia boa continua intacta');
  assert.equal(out.alertas.length, 1);
  assert.match(out.alertas[0], /messages-2026-09\.jsonl.*menor.*NAO enviado/);
});

test('mensal: so cria se o mes ainda nao tem; mes novo cria outro (os antigos ficam)', async () => {
  const root = makeRoot();
  const d = fakeDrive();
  const file = path.join(root, 'events.json');
  assert.equal(await ensureMonthlySnapshot({ file, rcloneRemote: R, month: '2026-11', exec: d.exec }), 'criado');
  assert.equal(await ensureMonthlySnapshot({ file, rcloneRemote: R, month: '2026-11', exec: d.exec }), 'ja_existia');
  assert.equal(await ensureMonthlySnapshot({ file, rcloneRemote: R, month: '2026-12', exec: d.exec }), 'criado');
  assert.deepEqual([...d.files.keys()].filter((k) => k.includes('/mensais/')).map((k) => k.split('/').pop()), ['bothierry-2026-11.tar.gz', 'bothierry-2026-12.tar.gz']);
});

test('falha no mensal ou no historico nao derruba o diario', async () => {
  const root = makeRoot();
  const d = fakeDrive();
  const exec = async (cmd, args, opts) => {
    if (cmd === 'rclone' && args[0] === 'lsf') throw new Error('Drive fora do ar');
    if (cmd === 'rclone' && args[0] === 'lsjson') throw new Error('quota excedida');
    return d.exec(cmd, args, opts);
  };
  const out = await runBackup({ root, rcloneRemote: R, exec });
  assert.equal(out.remote, true, 'o diario foi enviado');
  assert.match(out.monthly, /^erro: Drive fora do ar/);
  assert.match(out.historico.erros[0], /quota excedida/);
  assert.ok(fs.existsSync(out.file));
});

test('sem destino configurado: so o backup local; mantem 7 cópias', async () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, 'backups'));
  for (let i = 1; i <= 9; i++) fs.writeFileSync(path.join(root, 'backups', `bothierry-2026-01-0${i}.tar.gz`), 'x');
  const out = await runBackup({ root, rcloneRemote: '' });
  assert.equal(out.remote, false);
  assert.equal(out.monthly, null);
  assert.equal(out.historico, null);
  assert.equal(fs.readdirSync(path.join(root, 'backups')).length, 7);
});
