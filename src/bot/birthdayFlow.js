// Aniversarios: cartao, aviso as 9h, nome e foto do grupo (com a foto devolvida depois).

import { getMembersWithExtras } from '../extraMembers.js';
import { loadBirthdays, getPendingGroupRenames, setPendingGroupRenames, getLastGroupNameSyncDate, getBirthdaysToday, setLastGroupNameSyncDate, getLastBirthdayCheckDate, setLastBirthdayCheckDate } from '../birthdays.js';
import { birthdayDisplayName, resolveBirthdayMember, normalizeName } from '../birthdayLinks.js';
import { getBrasiliaNow, fetchGroups, getSharp, sentByBot } from './shared.js';
import { loadBackups, readBackupBuffer, removeBackup, saveBackup, setBackupUrlKey } from '../groupPhotoBackup.js';
import fs from 'fs';
import { getAvatarPath } from '../avatars.js';
import { readMemberPhoto, readBirthdayPhoto } from '../birthdayPhotos.js';
import { photoToDataUri, renderBirthdayCard } from '../birthdayCard.js';
import { maybePostAutoStatus } from './groupStatus.js';

// Membros do grupo principal (pra achar o nome de exibicao de cada aniversariante).
function getBirthdayMembers() {
  return getMembersWithExtras();
}

export async function commandAniversariantes({ sock, groupJid }) {
  const all = loadBirthdays();
  if (all.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Nenhum aniversariante cadastrado ainda (edite o arquivo birthdays.json).' });
  }
  const sorted = [...all].sort((a, b) => a.month - b.month || a.day - b.day);
  const members = getBirthdayMembers();
  const lines = sorted.map((b) => `${String(b.day).padStart(2, '0')}/${String(b.month).padStart(2, '0')} — ${birthdayDisplayName(b, members)}`);
  return sock.sendMessage(groupJid, { text: `🎂 Aniversariantes cadastrados:\n\n${lines.join('\n')}` });
}

// Reverte pro nome original os grupos que foram renomeados pra "Parabens" de
// um aniversario anterior (chamado sempre antes de processar o nome de hoje,
// pra nao acumular renomeacoes de dias passados).
// Identificador da foto de perfil de um grupo: o caminho da URL dela (sem os
// parametros de assinatura, que mudam a cada consulta). null se nao tem foto.
async function groupPhotoKey(sock, groupJid) {
  try {
    const url = await sock.profilePictureUrl(groupJid, 'image');
    return url ? new URL(url).pathname : null;
  } catch {
    return null;
  }
}

async function downloadGroupPhoto(sock, groupJid) {
  try {
    const url = await sock.profilePictureUrl(groupJid, 'image');
    if (!url) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

// Devolve a foto do grupo de antes do cartao de aniversario, quando o dia do
// aniversario passa (chamada junto com a reversao do nome, a meia-noite). Se
// alguem trocou a foto nesse meio tempo (!fotogrupo, troca automatica...), nao
// mexe: so descarta o backup. Grupo que nao tinha foto volta a ficar sem foto.
async function revertPendingGroupPhotos(sock) {
  const today = getBrasiliaNow().date;
  for (const [groupJid, entry] of Object.entries(loadBackups())) {
    if (entry.date >= today) continue; // o cartao ainda e de hoje
    try {
      const currentKey = await groupPhotoKey(sock, groupJid);
      if (entry.urlKey && currentKey && entry.urlKey !== currentKey) {
        console.log(`[foto do grupo] ${groupJid}: a foto foi trocada por outra pessoa, mantendo a atual`);
      } else {
        const original = readBackupBuffer(groupJid);
        if (original) await sock.updateProfilePicture(groupJid, original);
        else await sock.removeProfilePicture(groupJid);
        console.log(`🖼️  Foto do grupo ${groupJid} devolvida depois do aniversario`);
      }
      removeBackup(groupJid);
    } catch (err) {
      console.error(`Erro ao devolver a foto do grupo ${groupJid} (vai tentar de novo):`, err);
    }
  }
}

async function revertPendingGroupRenames(sock) {
  const pending = getPendingGroupRenames();
  const groupJids = Object.keys(pending);
  if (groupJids.length === 0) return;

  for (const groupJid of groupJids) {
    try {
      await sock.groupUpdateSubject(groupJid, pending[groupJid]);
    } catch (err) {
      console.error(`Erro ao reverter nome do grupo ${groupJid}:`, err);
    }
  }
  setPendingGroupRenames({});
}

// Junta uma lista de nomes em texto natural: "A" / "A e B" / "A, B e C".
function joinNamesWithE(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} e ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

/**
 * Sincroniza o NOME do grupo com o(s) aniversariante(s) de hoje — reverte
 * qualquer renomeacao de um dia anterior e, se hoje for aniversario de
 * alguem, renomeia de novo. Se houver mais de um aniversariante no mesmo dia
 * (ex: Lucas e Vini, 30/03), o nome junta os dois (ex: "Parabens, Lucas e
 * Vini!"), em vez de so o primeiro da lista. Roda logo depois da meia-noite
 * (cron) e tambem ao conectar, pra garantir que o nome ja esteja certo o
 * quanto antes, mesmo quando ha aniversarios em dias seguidos (ex: dia 07 e
 * 08) — nesse caso cada troca de dia ja reverte pro nome anterior (capturado
 * no dia de antes) e renomeia pro(s) aniversariante(s) novo(s), em sequencia,
 * sem nunca ficar "preso" num nome antigo. So uma vez por dia (controlado por
 * birthday_state.json).
 */
export async function syncGroupNameForBirthdays(sock) {
  const todayKey = getBrasiliaNow().date;
  if (getLastGroupNameSyncDate() === todayKey) return;

  await revertPendingGroupRenames(sock);
  await revertPendingGroupPhotos(sock);

  const todaysBirthdays = getBirthdaysToday();
  let allGroupJids = null; // cache: so busca se precisar (aniversariante sem groupJid definido)
  const namesByGroup = new Map(); // groupJid -> nomes dos aniversariantes de hoje nesse grupo

  for (const person of todaysBirthdays) {
    let targetJids = person.groupJid ? [person.groupJid] : null;
    if (!targetJids) {
      if (!allGroupJids) {
        const participating = await fetchGroups(sock);
        allGroupJids = Object.keys(participating);
      }
      targetJids = allGroupJids;
    }

    for (const groupJid of targetJids) {
      if (!namesByGroup.has(groupJid)) namesByGroup.set(groupJid, []);
      namesByGroup.get(groupJid).push(birthdayDisplayName(person, getBirthdayMembers()));
    }
  }

  const newPendingRenames = {};
  for (const [groupJid, names] of namesByGroup) {
    try {
      const metadata = await sock.groupMetadata(groupJid);
      newPendingRenames[groupJid] = metadata.subject;
      await sock.groupUpdateSubject(groupJid, `🎉 Parabéns, ${joinNamesWithE(names)}! 🎂`);
    } catch (err) {
      console.error(`Erro ao renomear grupo ${groupJid} pro(s) aniversario(s) de ${names.join(', ')}:`, err);
      delete newPendingRenames[groupJid];
    }
  }

  if (Object.keys(newPendingRenames).length > 0) setPendingGroupRenames(newPendingRenames);
  setLastGroupNameSyncDate(todayKey);
}

// Manda o aviso de texto de aniversario no grupo, no maximo uma vez por dia
// (controlado por birthday_state.json). O nome do grupo e tratado a parte,
// por syncGroupNameForBirthdays — essa funcao so cuida da mensagem.
// Foto do aniversariante: tenta a de resolucao cheia direto do WhatsApp (o
// cache do painel e pequeno, 128px, e borra num cartao grande); se a privacidade
// bloquear ou falhar, usa a do cache; sem nenhuma, o cartao usa a inicial.
export async function getBirthdayPhotoBuffer(sock, jid) {
  try {
    const url = await sock.profilePictureUrl(jid, 'image');
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  } catch {
    // sem foto / privacidade — cai no cache
  }
  try {
    const cached = fs.readFileSync(getAvatarPath(jid));
    if (cached.length > 0) return cached;
  } catch {
    // sem cache
  }
  return null;
}

// Monta o cartao de aniversario pra uma lista de pessoas { name, day, month }
// do mesmo dia. Lanca erro se nao der pra desenhar (quem chama cai no texto).
async function buildBirthdayCard(sock, people, members = getBirthdayMembers()) {
  const cardPeople = [];
  for (const person of people) {
    // Foto enviada na mao pelo painel vence a do WhatsApp.
    const match = resolveBirthdayMember(person, members);
    let photoUri = null;
    try {
      const uploaded = (match && readMemberPhoto(match.jid)) || readBirthdayPhoto(person.name);
      const buffer = uploaded || (match ? await getBirthdayPhotoBuffer(sock, match.jid) : null);
      if (buffer) photoUri = await photoToDataUri(buffer);
    } catch (err) {
      console.error(`Erro ao preparar a foto de ${person.name} pro cartao de aniversario:`, err);
    }
    cardPeople.push({ name: person.display || person.name, photoUri });
  }
  return renderBirthdayCard(cardPeople, people[0].day, people[0].month);
}

function birthdayCaption(people) {
  const names = people.map((p) => `*${p.display || p.name}*`);
  const joined = names.length > 1 ? `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}` : names[0];
  return `🎉🎂 Hoje é aniversário de ${joined}! Parabéns! 🎉🎂`;
}

// Manda o aviso de aniversario num grupo: cartao em imagem com a legenda; se o
// cartao nao puder ser gerado, manda so o texto (como era antes).
// Foto do grupo a partir do cartao: o cartao e vertical (1080x1350) e a foto do
// grupo e quadrada/redonda, entao o cartao inteiro entra centralizado (nada
// cortado) sobre uma versao borrada dele mesmo preenchendo as laterais.
async function birthdayCardToGroupPhoto(card) {
  const sharp = await getSharp();
  const background = await sharp(card).resize(640, 640, { fit: 'cover' }).blur(28).toBuffer();
  const foreground = await sharp(card).resize({ height: 640 }).toBuffer();
  return sharp(background).composite([{ input: foreground, gravity: 'centre' }]).jpeg({ quality: 90 }).toBuffer();
}

// setGroupPhoto: depois de mandar o cartao, usa ele como foto do grupo (so o
// aviso automatico das 9h faz isso; o !testaraniversario nao mexe na foto).
async function sendBirthdayToGroup(sock, groupJid, rawPeople, { setGroupPhoto = false } = {}) {
  // "name" continua sendo o da lista (pra achar foto/ligacao); "display" e o nome padronizado que sai no texto.
  const members = getBirthdayMembers();
  const people = rawPeople.map((p) => ({ ...p, display: birthdayDisplayName(p, members) }));
  const caption = birthdayCaption(people);
  let image = null;
  try {
    image = await buildBirthdayCard(sock, people, members);
  } catch (err) {
    console.error('Erro ao montar o cartao de aniversario (mandando em texto):', err);
  }
  const sent = await sock.sendMessage(groupJid, image ? { image, caption } : { text: caption });
  if (sent?.key?.id) sentByBot.add(sent.key.id);

  // O cartao tambem como status do grupo (so no aviso automatico; o !testaraniversario nao posta status).
  if (setGroupPhoto && image) await maybePostAutoStatus(sock, groupJid, 'aniversario', { image, caption });

  if (setGroupPhoto && image) {
    try {
      const today = getBrasiliaNow().date;
      // Guarda a foto original so na primeira vez (aniversarios em dias seguidos nao sobrescrevem o backup com um cartao).
      if (!loadBackups()[groupJid]) saveBackup(groupJid, await downloadGroupPhoto(sock, groupJid), today);
      await sock.updateProfilePicture(groupJid, await birthdayCardToGroupPhoto(image));
      setBackupUrlKey(groupJid, await groupPhotoKey(sock, groupJid), today);
      console.log(`🖼️  Foto do grupo ${groupJid} trocada pelo cartao de aniversario`);
    } catch (err) {
      console.error('Erro ao usar o cartao de aniversario como foto do grupo (o bot precisa ser admin):', err);
    }
  }
}

export async function checkAndSendBirthdays(sock) {
  const todayKey = getBrasiliaNow().date;
  if (getLastBirthdayCheckDate() === todayKey) return;

  const todaysBirthdays = getBirthdaysToday();
  let allGroupJids = null; // cache: so busca se precisar (aniversariante sem groupJid definido)

  // Um cartao por grupo, juntando quem faz aniversario no mesmo dia.
  const peopleByGroup = new Map();
  for (const person of todaysBirthdays) {
    let targetJids = person.groupJid ? [person.groupJid] : null;
    if (!targetJids) {
      if (!allGroupJids) {
        const participating = await fetchGroups(sock);
        allGroupJids = Object.keys(participating);
      }
      targetJids = allGroupJids;
    }
    for (const groupJid of targetJids) {
      if (!peopleByGroup.has(groupJid)) peopleByGroup.set(groupJid, []);
      peopleByGroup.get(groupJid).push(person);
    }
  }

  for (const [groupJid, people] of peopleByGroup) {
    try {
      await sendBirthdayToGroup(sock, groupJid, people, { setGroupPhoto: true });
    } catch (err) {
      console.error(`Erro ao enviar aviso de aniversario (${people.map((p) => p.name).join(', ')}) para ${groupJid}:`, err);
    }
  }

  setLastBirthdayCheckDate(todayKey);
}

// !testaraniversario [nome] — manda o cartao so no grupo onde foi digitado, pra
// ver como fica: usa o aniversariante com esse nome, ou o proximo da lista.
export async function commandTestarAniversario({ sock, groupJid, args }) {
  const all = loadBirthdays();
  if (all.length === 0) return sock.sendMessage(groupJid, { text: 'Nenhum aniversariante cadastrado.' });

  const query = normalizeName(args);
  let person = query ? all.find((b) => normalizeName(b.name).includes(query)) : null;
  if (query && !person) return sock.sendMessage(groupJid, { text: `Não achei "${args}" na lista de aniversariantes.` });
  if (!person) {
    const today = getBrasiliaNow().date; // YYYY-MM-DD
    const todayKey = Number(today.slice(5, 7)) * 100 + Number(today.slice(8, 10));
    const keyOf = (b) => b.month * 100 + b.day;
    person = [...all].sort((a, b) => keyOf(a) - keyOf(b)).find((b) => keyOf(b) >= todayKey) || [...all].sort((a, b) => keyOf(a) - keyOf(b))[0];
  }
  const sameDay = all.filter((b) => b.day === person.day && b.month === person.month);
  return sendBirthdayToGroup(sock, groupJid, query ? [person] : sameDay);
}
