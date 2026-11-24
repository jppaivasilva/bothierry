// Audios salvos: listar, salvar, apagar e mandar pelo nome.

import path from 'path';
import fs from 'fs';
import { AUDIOS_DIR, AUDIO_EXTENSIONS, sentByBot } from './shared.js';
import { getQuotedMedia } from './basicCommands.js';
import { commands } from './commands.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { recordAudioUse } from '../audioUsage.js';

export function getAudioMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.ogg') return 'audio/ogg; codecs=opus';
  return 'audio/mpeg';
}

// Lista os audios da pasta audios/, ordenados por nome. "name" (sem extensao,
// minusculo) e o que vira comando: !<name>. "filename" e o nome real do
// arquivo em disco, usado pra ler/enviar.
export function listAudioFiles() {
  if (!fs.existsSync(AUDIOS_DIR)) return [];
  return fs
    .readdirSync(AUDIOS_DIR)
    .filter((filename) => AUDIO_EXTENSIONS.includes(path.extname(filename).toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    .map((filename) => ({ name: path.basename(filename, path.extname(filename)).toLowerCase(), filename }));
}

export async function commandAudios({ sock, groupJid }) {
  const audios = listAudioFiles();
  if (audios.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Nenhum áudio disponível na pasta audios/ ainda.' });
  }
  const lines = audios.map((a, i) => `${i + 1}. !${a.name}`);
  return sock.sendMessage(groupJid, { text: `🔊 *Áudios disponíveis*\n\n${lines.join('\n')}` });
}

// Normaliza o nome escolhido pra um audio salvo: minusculo, sem acento, so
// letras/numeros/_/-, ate 30 caracteres. Retorna '' se sobrar nada.
function sanitizeAudioName(raw) {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 30);
}

// !salvaraudio <nome> — responda um audio do grupo pra salvar ele em audios/;
// depois qualquer um chama com !<nome>.
export async function commandSalvarAudio({ sock, groupJid, args, msg }) {
  const quotedAudio = getQuotedMedia(msg, 'audioMessage');
  if (!quotedAudio) {
    return sock.sendMessage(groupJid, { text: 'Responda a um áudio do grupo com !salvaraudio nome pra eu salvar ele.' });
  }

  const name = sanitizeAudioName(args.split(/\s+/)[0] || '');
  if (!name) {
    return sock.sendMessage(groupJid, { text: 'Faltou o nome! Responda o áudio com !salvaraudio nome (só letras, números, _ e -).' });
  }
  if (commands[name] || listAudioFiles().some((a) => a.name === name)) {
    return sock.sendMessage(groupJid, { text: `Já existe um comando ou áudio chamado !${name}, escolhe outro nome.` });
  }

  try {
    const mimetype = quotedAudio.message.audioMessage?.mimetype || '';
    const ext = mimetype.includes('mp4') ? 'm4a' : mimetype.includes('mpeg') ? 'mp3' : mimetype.includes('wav') ? 'wav' : 'ogg';

    const buffer = await downloadMediaMessage(quotedAudio, 'buffer', {});
    fs.mkdirSync(AUDIOS_DIR, { recursive: true });
    fs.writeFileSync(path.join(AUDIOS_DIR, `${name}.${ext}`), buffer);

    return sock.sendMessage(groupJid, { text: `✅ Áudio salvo! Agora é só mandar !${name}` });
  } catch (err) {
    console.error('Erro ao salvar áudio:', err);
    return sock.sendMessage(groupJid, { text: 'Não consegui salvar esse áudio, tenta de novo daqui a pouco.' });
  }
}

// Apaga um audio salvo (usado pelo painel). Valida o nome pra nunca sair da
// pasta audios/, e protege o repetido.mp3 (tocado no aviso de link repetido).
export function deleteAudioByName(rawName) {
  const name = String(rawName).toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(name)) return { ok: false, error: 'nome inválido' };
  if (name === 'repetido') return { ok: false, error: 'esse áudio é do aviso de link repetido e não pode ser apagado' };
  const audio = listAudioFiles().find((a) => a.name === name);
  if (!audio) return { ok: false, error: 'áudio não encontrado' };
  try {
    fs.unlinkSync(path.join(AUDIOS_DIR, audio.filename));
    return { ok: true };
  } catch (err) {
    console.error(`Erro ao apagar audio ${name}:`, err);
    return { ok: false, error: 'não consegui apagar o arquivo' };
  }
}

// Envia um audio pelo nome (sem extensao, minusculo) — usado como fallback
// quando um comando digitado nao bate com nenhum dos fixos, mas bate com um
// arquivo em audios/.
export async function sendAudioByName({ sock, groupJid }, name) {
  const audio = listAudioFiles().find((a) => a.name === name);
  if (!audio) return false;

  try {
    const sent = await sock.sendMessage(groupJid, {
      audio: fs.readFileSync(path.join(AUDIOS_DIR, audio.filename)),
      mimetype: getAudioMimeType(audio.filename),
      // .ogg vem de mensagem de voz do WhatsApp (opus) — precisa do ptt pra tocar.
      ptt: path.extname(audio.filename).toLowerCase() === '.ogg',
    });
    if (sent?.key?.id) sentByBot.add(sent.key.id);
    recordAudioUse(name);
  } catch (err) {
    console.error(`Erro ao enviar audio ${name}:`, err);
  }
  return true;
}
