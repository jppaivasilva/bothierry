import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVENTS_FILE = path.join(__dirname, '..', 'events.json');

function ensureEventsFile() {
  if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, '[]\n');
}

/**
 * Le a lista de eventos de events.json.
 * Cada entrada: { title, date: "YYYY-MM-DD", location, time, extra?: { [label]: valor }, attendees?: [{ jid, name }] }
 * "extra" e um objeto livre pra campos extras tipo Comida/Bebida.
 */
export function loadEvents() {
  ensureEventsFile();
  const content = fs.readFileSync(EVENTS_FILE, 'utf-8');
  if (!content.trim()) return [];
  return JSON.parse(content);
}

function saveEvents(events) {
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2) + '\n');
}

/**
 * Adiciona um novo evento ao events.json (usado pelo !addevento).
 */
export function addEvent(event) {
  const events = loadEvents();
  events.push(event);
  saveEvents(events);
  return event;
}

function normalize(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Retorna os eventos futuros (data >= hoje) cujo titulo contenha o termo de
 * busca (sem acento, case-insensitive). Sem termo, retorna todos os futuros.
 */
export function findUpcomingEvents(query) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const upcoming = loadEvents().filter((e) => e.date >= today);
  if (!query) return upcoming;
  const normalizedQuery = normalize(query);
  return upcoming.filter((e) => normalize(e.title).includes(normalizedQuery));
}

/**
 * Confirma presenca de alguem num evento (identificado pelo titulo exato).
 * Nao duplica se a pessoa ja tiver confirmado, e remove ela da lista de
 * ausentes se estiver la (!vou depois de !naovou substitui). Retorna o
 * evento atualizado, ou null se o titulo nao for encontrado.
 */
export function addAttendee(eventTitle, attendee) {
  const events = loadEvents();
  const event = events.find((e) => e.title === eventTitle);
  if (!event) return null;

  event.attendees = event.attendees || [];
  event.absentees = (event.absentees || []).filter((a) => a.jid !== attendee.jid);
  if (!event.attendees.some((a) => a.jid === attendee.jid)) {
    event.attendees.push(attendee);
  }
  saveEvents(events);
  return event;
}

/**
 * Marca alguem como ausente num evento (identificado pelo titulo exato).
 * Mesma logica do addAttendee, mas na lista de ausentes (e removendo dos
 * confirmados, se estiver la).
 */
export function addAbsentee(eventTitle, absentee) {
  const events = loadEvents();
  const event = events.find((e) => e.title === eventTitle);
  if (!event) return null;

  event.absentees = event.absentees || [];
  event.attendees = (event.attendees || []).filter((a) => a.jid !== absentee.jid);
  if (!event.absentees.some((a) => a.jid === absentee.jid)) {
    event.absentees.push(absentee);
  }
  saveEvents(events);
  return event;
}
