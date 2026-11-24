import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bot');

test('todos os modulos de src/bot carregam sem erro (imports e ordem de inicializacao)', async () => {
  const files = fs.readdirSync(BOT_DIR).filter((f) => f.endsWith('.js') && f !== 'bootstrap.js');
  assert.ok(files.length >= 10);
  for (const f of files) await import(path.join(BOT_DIR, f));
});

test('mapa de comandos: todo comando e uma funcao e os essenciais existem', async () => {
  const { commands, COMMAND_CATEGORIES } = await import(path.join(BOT_DIR, 'commands.js'));
  for (const [name, fn] of Object.entries(commands)) assert.equal(typeof fn, 'function', `!${name}`);
  for (const name of ['ranking', 'menu', 'wrapped', 'eventos', 'vou', 'naovou', 'audios', 'resumo', 'testarnoticias']) assert.ok(commands[name], `falta !${name}`);
  assert.ok(COMMAND_CATEGORIES.length > 3);
});
