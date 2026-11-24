// Eventos: listar, cadastrar, Vou / Nao vou e o aviso de evento novo.

import { loadEvents, eventTitleExists, addEvent, findUpcomingEvents, addAttendee, addAbsentee } from '../events.js';
import { getBrasiliaNow, formatDateBR, stripAccents, parseDateBR, botState, findMainGroupJid, sentByBot } from './shared.js';
import { formatDisplayName } from '../displayNames.js';

export async function commandEventos({ sock, groupJid }) {
  const events = loadEvents();
  if (events.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Nenhum evento cadastrado ainda (edite o arquivo events.json).' });
  }

  const today = getBrasiliaNow().date;
  const upcoming = events.filter((e) => e.date >= today);
  if (upcoming.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Nenhum evento futuro cadastrado no momento.' });
  }

  const sorted = [...upcoming].sort((a, b) => a.date.localeCompare(b.date));
  const blocks = sorted.map((e, i) => {
    const lines = [`📅 *${e.title}*`, `Data: ${formatDateBR(e.date)}`, `Local: ${e.location}`, `Horário: ${e.time}`];
    for (const [label, value] of Object.entries(e.extra || {})) {
      lines.push(`${label}: ${value}`);
    }
    if (e.attendees?.length) {
      lines.push(`Confirmados (${e.attendees.length}):`);
      e.attendees.forEach((a, idx) => lines.push(`${idx + 1}. ${formatDisplayName(a.name)}`));
    }
    if (e.absentees?.length) {
      if (e.attendees?.length) lines.push('----');
      lines.push(`Ausentes (${e.absentees.length}):`);
      e.absentees.forEach((a, idx) => lines.push(`${idx + 1}. ${formatDisplayName(a.name)}`));
    }
    const block = lines.join('\n');
    return sorted.length > 1 ? `*EVENTO ${i + 1}*\n\n${block}` : block;
  });

  return sock.sendMessage(groupJid, { text: blocks.join('\n\n-----------------\n\n') });
}

export async function commandAddEvento({ sock, groupJid, args }) {
  const usage =
    'Formato: !addevento, nome do evento numa linha e depois os campos, um por linha. Exemplo:\n\n' +
    '!addevento\nChurrasco de fim de ano\nData: 20/12/26\nHorário: 13h\nLocal: Casa do Thierry';

  const lines = args.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    return sock.sendMessage(groupJid, { text: usage });
  }

  const [title, ...detailLines] = lines;
  let date = null;
  let location = null;
  let time = null;
  const extra = {};

  for (const line of detailLines) {
    // linha solta tipo "13:00" ou "13h" (sem rotulo "Horário:") — trata como horario
    // direto, senao ia virar um campo extra sem sentido tipo { "13": "00" }.
    if (!time && /^\d{1,2}([:h]\d{0,2})?h?$/i.test(line)) {
      time = line;
      continue;
    }

    const sepIndex = line.indexOf(':');
    if (sepIndex === -1) continue;
    const label = line.slice(0, sepIndex).trim();
    const value = line.slice(sepIndex + 1).trim();
    const normalizedLabel = stripAccents(label);

    if (normalizedLabel === 'data') date = parseDateBR(value);
    else if (normalizedLabel === 'local') location = value;
    else if (normalizedLabel === 'horario') time = value;
    else extra[label] = value;
  }

  if (!date) {
    return sock.sendMessage(groupJid, {
      text: 'Não consegui entender a data do evento. Use "Data: DD/MM/AA" (ex: Data: 03/10/26).\n\n' + usage,
    });
  }

  if (eventTitleExists(title)) {
    return sock.sendMessage(groupJid, { text: `Já existe um evento chamado *${title}*. Use outro nome (o nome identifica o evento).` });
  }

  const event = {
    title,
    date,
    location: location || '(local não informado)',
    time: time || '(horário não informado)',
    extra,
  };
  addEvent(event);

  const confirmLines = [`✅ Evento cadastrado:`, ``, `📅 *${event.title}*`, `Data: ${formatDateBR(event.date)}`, `Local: ${event.location}`, `Horário: ${event.time}`];
  for (const [label, value] of Object.entries(extra)) confirmLines.push(`${label}: ${value}`);

  return sock.sendMessage(groupJid, { text: confirmLines.join('\n') });
}

// Logica compartilhada por !vou e !naovou: acha o evento (por !vou sozinho
// quando so ha um futuro, por "evento1"/"evento2" ou por nome/trecho) e
// aplica storeFn (addAttendee ou addAbsentee) nele.
async function handleAttendanceCommand({ sock, groupJid, senderJid, senderName, args }, { commandName, storeFn, successText }) {
  const query = args.trim();
  // mesma ordem/numeracao usada pelo !eventos (EVENTO 1, EVENTO 2...)
  const upcoming = findUpcomingEvents('').sort((a, b) => a.date.localeCompare(b.date));

  if (upcoming.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Não há eventos futuros cadastrados. Use !addevento pra criar um.' });
  }

  const indexMatch = query.match(/^evento\s*(\d+)$/i);

  let matches;
  if (indexMatch) {
    const event = upcoming[Number(indexMatch[1]) - 1];
    matches = event ? [event] : [];
  } else if (!query) {
    if (upcoming.length === 1) {
      matches = upcoming;
    } else {
      const options = upcoming.map((e, i) => `!${commandName} evento${i + 1}`).join('\n');
      return sock.sendMessage(groupJid, { text: `Tem mais de um evento futuro. Qual deles?\n\n${options}` });
    }
  } else {
    matches = findUpcomingEvents(query);
  }

  if (matches.length === 0) {
    return sock.sendMessage(groupJid, { text: `Não encontrei nenhum evento futuro com "${query}". Digite !eventos pra ver os cadastrados e o número de cada um.` });
  }
  if (matches.length > 1) {
    const options = matches.map((e) => `!${commandName} ${e.title}`).join('\n');
    return sock.sendMessage(groupJid, { text: `Achei mais de um evento com esse nome. Qual deles?\n\n${options}` });
  }

  const event = matches[0];
  storeFn(event.title, { jid: senderJid, name: senderName });
  return sock.sendMessage(groupJid, { text: successText(event, senderName) });
}

export async function commandVou(ctx) {
  return handleAttendanceCommand(ctx, {
    commandName: 'vou',
    storeFn: addAttendee,
    successText: (event, senderName) => `✅ ${formatDisplayName(senderName)} confirmado(a) em *${event.title}*!`,
  });
}

export async function commandNaoVou(ctx) {
  return handleAttendanceCommand(ctx, {
    commandName: 'naovou',
    storeFn: addAbsentee,
    successText: (event, senderName) => `❌ ${formatDisplayName(senderName)} marcado(a) como ausente em *${event.title}*.`,
  });
}

// Evento criado pelo painel: o bot avisa no grupo, igual a confirmacao do
// !addevento (so que sem ninguem ter digitado o comando). Se o bot estiver
// desconectado ou nao achar o grupo, so nao avisa — o evento ja foi salvo.
export async function announceNewEvent(event, createdBy) {
  if (!botState.sock) return;
  const groupJid = await findMainGroupJid(botState.sock);
  if (!groupJid) return;
  const lines = ['📣 *Novo evento!*', '', `📅 *${event.title}*`, `Data: ${formatDateBR(event.date)}`, `Local: ${event.location}`, `Horário: ${event.time}`];
  for (const [label, value] of Object.entries(event.extra || {})) lines.push(`${label}: ${value}`);
  lines.push('', createdBy ? `Criado por ${createdBy} no painel.` : 'Criado pelo painel.');
  lines.push('Confirme com *!vou* ou *!naovou* (ou pelo painel: mande *!painel*).');
  const sent = await botState.sock.sendMessage(groupJid, { text: lines.join('\n') });
  if (sent?.key?.id) sentByBot.add(sent.key.id);
}
