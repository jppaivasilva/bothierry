import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { getDashboardData, getMessagesPerHourForDate, getSystemStats, getSystemStatsHistory } from './metrics.js';
import { getCountsBetween, getMainGroupJid, getMessageTrend, getActivityHeatmap, getTopSenderPerHour, getMemberList, getMemberStats } from './db.js';
import { loadBirthdays } from './birthdays.js';
import { resolveBirthdayMember, setBirthdayLink, normalizeName } from './birthdayLinks.js';
import { BOT_PHOTO_PATH } from './groupPhoto.js';
import { formatDisplayName } from './displayNames.js';
import { getAvatarPath } from './avatars.js';
import { loadEvents, addAttendee, addAbsentee } from './events.js';

// Usuario/senha do painel (HTTP Basic Auth) — agora que o painel ficou
// exposto num IP publico (antes era so localhost), precisa de login pra
// nao deixar qualquer um na internet ver as mensagens/ranking do grupo.
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || '';

// Usuario administrador (ve tambem as opcoes de apagar audio, reiniciar o bot e
// ver logs). A senha vem SO do .env da VM (nunca do codigo — o repositorio e
// publico); sem ADMIN_PASS configurada, ninguem consegue entrar como admin.
const ADMIN_USER = process.env.ADMIN_USER || 'root';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

// Compara usuario/senha em tempo constante (evita timing attack) — so
// funciona se os dois buffers tiverem o mesmo tamanho, por isso o padding.
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Limite de tentativas de login por IP — sem isso, alguem pode tentar senha
// atras de senha sem nenhum freio (forca bruta). Janela deslizante simples
// em memoria (reseta se o bot reiniciar, o que e aceitavel aqui).
const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_ATTEMPT_WINDOW_MS = 5 * 60 * 1000; // 5 minutos
const loginAttemptsByIp = new Map(); // ip -> [timestamps]

function isRateLimited(ip) {
  const now = Date.now();
  const attempts = (loginAttemptsByIp.get(ip) || []).filter((t) => now - t < LOGIN_ATTEMPT_WINDOW_MS);
  loginAttemptsByIp.set(ip, attempts);
  return attempts.length >= LOGIN_ATTEMPT_LIMIT;
}

function recordFailedLogin(ip) {
  const attempts = loginAttemptsByIp.get(ip) || [];
  attempts.push(Date.now());
  loginAttemptsByIp.set(ip, attempts);
}

// Sessao via cookie assinado (HMAC), no lugar do prompt feio do navegador
// (HTTP Basic Auth) — assim da pra ter uma tela de login bonita, no estilo
// do resto do painel. O cookie carrega so a validade + assinatura, sem
// estado nenhum guardado no servidor (sobrevive a reinicio do bot).
const SESSION_COOKIE_NAME = 'bothierry_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

function signSession(payload) {
  return crypto
    .createHmac('sha256', `${DASHBOARD_USER}:${DASHBOARD_PASS}:${ADMIN_USER}:${ADMIN_PASS}`)
    .update(payload)
    .digest('hex');
}

// Cookie: "<validade>.<papel>.<identidade>.<assinatura>", papel = viewer |
// admin | member. "member" e quem entrou pelo link do !painel e leva dentro
// o jid/nome do WhatsApp (base64url; "-" quando nao tem). Tudo isso entra na
// assinatura, entao nao da pra trocar de papel nem de pessoa na mao.
function makeSessionCookieValue(role, identity = null) {
  const idPart = identity ? Buffer.from(JSON.stringify(identity)).toString('base64url') : '-';
  const payload = `${Date.now() + SESSION_MAX_AGE_MS}.${role}.${idPart}`;
  return `${payload}.${signSession(payload)}`;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const sepIdx = part.indexOf('=');
    if (sepIdx === -1) continue;
    cookies[part.slice(0, sepIdx).trim()] = decodeURIComponent(part.slice(sepIdx + 1).trim());
  }
  return cookies;
}

// Cache em memoria das fotos (bot + avatares) — evita ler o arquivo do disco
// de novo a cada request. O painel atualiza a cada 5s e cada carregamento
// pede varias fotos (ranking + campeoes da hora), entao sem cache isso vira
// um monte de leitura de disco repetida. Guarda o mtime junto pra invalidar
// sozinho se o arquivo mudar (ex: foto nova sincronizada ou trocada na mao).
const imageCache = new Map(); // path -> { mtimeMs, buffer }

// Le e serve uma imagem de forma assincrona (fs.promises), nunca bloqueando
// o event loop — antes isso usava fs.readFileSync, que trava o processo
// inteiro (inclusive o keep-alive da conexao com o WhatsApp) enquanto le do
// disco, pior ainda numa VM pequena com disco mais lento.
async function serveCachedImage(filePath, contentType, res) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size === 0) throw new Error('arquivo vazio (marcador de "sem foto")');
    const cached = imageCache.get(filePath);
    let buffer;
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      buffer = cached.buffer;
    } else {
      buffer = await fs.promises.readFile(filePath);
      imageCache.set(filePath, { mtimeMs: stat.mtimeMs, buffer });
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
    res.end(buffer);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Nao encontrado');
  }
}

// Sessao do cookie: { role, jid, name } (jid/name so pra member), ou null se
// nao tem sessao valida.
function getSession(req) {
  const value = parseCookies(req)[SESSION_COOKIE_NAME];
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const [expiryStr, role, idPart, sig] = parts;
  const expiry = Number(expiryStr);
  if (!expiry || Date.now() > expiry) return null;
  if (role !== 'viewer' && role !== 'admin' && role !== 'member') return null;
  if (!safeEqual(sig, signSession(`${expiryStr}.${role}.${idPart}`))) return null;
  if (role !== 'member') return { role };
  try {
    const identity = JSON.parse(Buffer.from(idPart, 'base64url').toString('utf-8'));
    return identity?.jid ? { role, jid: identity.jid, name: identity.name || '' } : null;
  } catch {
    return null;
  }
}

function isAuthorized(req) {
  if (!DASHBOARD_PASS) return true; // sem senha configurada, nao bloqueia (fallback pro comportamento antigo)
  return getSession(req) !== null;
}

function isAdmin(req) {
  return getSession(req)?.role === 'admin';
}

// Converte uma data (YYYY-MM-DD, fuso de Brasilia) + hora local num timestamp
// unix. Brasil nao tem horario de verao desde 2019, entao o offset fixo -03:00 e seguro.
function timestampBR(dateStr, hour) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day, hour + 3, 0, 0) / 1000);
}

function getBrasiliaToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

/**
 * Ranking de mensagens de hoje entre duas horas (horario de Brasilia), do
 * grupo principal (o mais ativo) — mesma logica do !ranking/relatorio, exposta pro
 * painel poder mostrar isso ao vivo. hourUntil pode ser 24 (meia-noite do dia
 * seguinte) pra cobrir o dia inteiro.
 */
function getTodayRanking(hourSince, hourUntil, date) {
  const groupJid = getMainGroupJid();
  const today = date || getBrasiliaToday();
  if (!groupJid) return { date: today, total: 0, ranking: [] };

  const counts = getCountsBetween(groupJid, timestampBR(today, hourSince), timestampBR(today, hourUntil));
  const total = counts.reduce((sum, c) => sum + c.total, 0);
  return {
    date: today,
    total,
    ranking: counts.map((c, i) => ({ posicao: i + 1, nome: formatDisplayName(c.sender_name), jid: c.sender_jid, mensagens: c.total, percentual: total ? Math.round((c.total / total) * 100) : 0 })),
  };
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>Bothierry Comichosas</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script><style>
  :root {
    color-scheme: light;
    /* Cores semanticas do sistema Apple (iOS/macOS HIG), so modo claro. */
    --bg-gradient:
      radial-gradient(1200px 700px at 12% -10%, rgba(0,122,255,.16), transparent 60%),
      radial-gradient(1000px 650px at 95% 0%, rgba(175,82,222,.14), transparent 55%),
      radial-gradient(900px 600px at 50% 100%, rgba(52,199,89,.12), transparent 60%),
      linear-gradient(180deg, #eef1f6 0%, #e9edf5 100%);
    --text-primary: rgba(0,0,0,.85);
    --text-secondary: rgba(60,60,67,.6);
    --glass-bg: rgba(255,255,255,.58);
    --glass-border: rgba(255,255,255,.6);
    --glass-shadow: 0 8px 32px rgba(31,41,55,.10), inset 0 1px 0 rgba(255,255,255,.7);
    --divider: rgba(60,60,67,.12);
    --accent-green: #34c759;
    --accent-red: #ff3b30;
    --accent-orange: #ff9500;
    --accent-blue: #007aff;
    --pill-bg: rgba(118,118,128,.12);
    --accent-purple: #af52de;
    /* Curvas de easing mais fortes que as nativas do CSS — entram rapido
       (ease-out), nunca usam ease-in (parece lento/hesitante numa UI). */
    --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
    --radius-lg: 18px;
    --radius-md: 12px;
  }
  * { box-sizing: border-box; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
  @keyframes float-blob {
    0%, 100% { transform: translate(0,0) scale(1); }
    50% { transform: translate(24px,-18px) scale(1.06); }
  }
  @keyframes fade-up {
    from { opacity: 0; transform: translateY(14px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .blob { position: fixed; border-radius: 50%; filter: blur(10px); pointer-events: none; z-index: 0; animation: float-blob 16s ease-in-out infinite; }
  .blob-1 { top: -120px; left: -80px; width: 420px; height: 420px; background: radial-gradient(circle at 30% 30%, rgba(0,122,255,.30), rgba(0,122,255,0) 70%); }
  .blob-2 { top: 260px; right: -140px; width: 480px; height: 480px; background: radial-gradient(circle at 60% 40%, rgba(175,82,222,.26), rgba(175,82,222,0) 70%); animation-direction: reverse; animation-duration: 20s; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, sans-serif;
    background: var(--bg-gradient);
    background-attachment: fixed;
    color: var(--text-primary);
    margin: 0;
    padding: 32px;
    -webkit-font-smoothing: antialiased;
    position: relative;
  }
  body > *:not(.blob) { position: relative; z-index: 1; }
  h1 { font-size: 28px; font-weight: 700; letter-spacing: -.02em; margin: 0; line-height: 1.1; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
  .brand-photo { width: 44px; height: 44px; border-radius: 50%; object-fit: cover; box-shadow: 0 2px 8px rgba(0,0,0,.14); }
  .eyebrow { font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--accent-blue); margin: 0 0 2px; }
  .topbar {
    border-radius: var(--radius-lg);
    padding: 14px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 28px;
    background: rgba(255,255,255,.72);
    backdrop-filter: blur(32px) saturate(180%);
    -webkit-backdrop-filter: blur(32px) saturate(180%);
  }
  .topbar .brand { margin-bottom: 0; }
  .header-status { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  .live-pill { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--text-secondary); }
  .logout-link { font-size: 12px; font-weight: 600; color: var(--text-secondary); text-decoration: none; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--glass-border); transition: color .15s var(--ease-out), background .15s var(--ease-out); }
  .logout-link:hover { color: var(--accent-red); background: rgba(255,59,48,.08); }
  .live-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent-green); display: inline-block; animation: pulse-dot 2.2s ease-out infinite; }
  .section-head { margin-bottom: 14px; }
  /* Titulo/subtitulo de card sao globais (nao so dentro de .section-head) —
     assim todo card segue o mesmo padrao visual, nao so quem usa esse
     wrapper especifico. */
  .title { font-size: 16px; font-weight: 700; letter-spacing: -.01em; color: var(--text-primary); }
  /* So pro subtitulo de card (abaixo do .title) — NAO no .label generico
     usado tambem em rotulos de filtro inline ("Data:", "Periodo:"), que
     precisam continuar em linha, nao quebrando pra bloco. */
  .subtitle { font-size: 13px; margin-top: 1px; display: block; }
  .person { display: flex; align-items: center; gap: 8px; }
  .avatar-mini, .avatar-fallback { width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 0 2px #fff, 0 3px 8px rgba(0,0,0,.1); }
  /* Fileira dos "reis da hora", de verdade em HTML (nao desenhada no canvas
     do grafico) — fica ACIMA do grafico, nao sobreposta aos dados. Padding
     a esquerda aproxima do inicio da area de plotagem (depois do eixo Y). */
  /* Posicionado em cima da barra de verdade: cada .hour-champion e absolute,
     com "left" calculado em JS a partir da posicao real da barra no Chart.js
     (nao uma aproximacao fixa) — centraliza de verdade mesmo quando o
     grafico redimensiona. */
  /* Em telas estreitas (celular), 24 barras espremidas deixam as fotos/nomes
     sobrepostos — em vez de comprimir, o grafico vira horizontalmente
     rolavel e mantem a largura minima confortavel por hora (contra o
     celular ficar ilegivel, prefere rolar a espremer — mesma logica de
     "wide tables get overflow-x:auto"). No desktop a largura disponivel ja
     cobre 760px, entao nunca aparece barra de rolagem ali. */
  .chart-scroll { overflow-x: auto; width: 100%; }
  /* position:relative e obrigatorio aqui — e assim que o Chart.js (com
     responsive:true) calcula o tamanho do canvas a partir do container pai;
     sem isso ele nao redimensiona direito ao mudar o tamanho da tela. */
  .chart-scroll-inner { position: relative; width: 100%; min-width: 760px; }
  .hour-champions { position: relative; height: 76px; margin-bottom: 4px; }
  .hour-champion { position: absolute; top: 0; transform: translateX(-50%); width: 56px; display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .hour-champion .crown { font-size: 13px; line-height: 1; }
  .hour-champion .avatar-mini, .hour-champion .avatar-fallback { width: 30px; height: 30px; font-size: 11px; }
  .hour-champion .name { font-size: 10px; font-weight: 600; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .ranking-list { display: flex; flex-direction: column; gap: 14px; }
  .ranking-row { display: flex; align-items: center; gap: 12px; }
  .ranking-pos { font-size: 13px; font-weight: 800; color: rgba(60,60,67,.45); width: 18px; flex-shrink: 0; }
  .ranking-row .avatar-mini, .ranking-row .avatar-fallback { width: 34px; height: 34px; font-size: 12px; }
  .ranking-name { font-size: 13px; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ranking-bar-track { height: 6px; border-radius: 999px; background: rgba(118,118,128,.14); margin-top: 5px; overflow: hidden; }
  .ranking-bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent-blue), var(--accent-purple)); transition: width .5s var(--ease-out); }
  .ranking-count { font-size: 13px; font-weight: 700; color: var(--text-primary); flex-shrink: 0; }
  .events-list { display: flex; flex-direction: column; gap: 12px; }
  .events-row { display: flex; align-items: center; gap: 10px; }
  .events-detail { font-size: 12px; color: var(--text-secondary); flex: 1; }
  .events-time { font-size: 11px; color: rgba(60,60,67,.45); flex-shrink: 0; }
  .avatar-mini { object-fit: cover; }
  .avatar-fallback { display: flex; align-items: center; justify-content: center; background: var(--accent-blue); color: #fff; font-size: 10px; font-weight: 700; }
  .sub { color: var(--text-secondary); font-size: 13px; margin-bottom: 24px; }
  .label { color: var(--text-secondary); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 28px; }
  .card, .chart-box {
    background: var(--glass-bg);
    backdrop-filter: blur(28px) saturate(180%);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-lg);
    padding: 20px;
    box-shadow: var(--glass-shadow);
    animation: fade-up .5s var(--ease-out) both;
    transition: transform .35s var(--ease-out), box-shadow .35s var(--ease-out);
  }
  .card:hover, .chart-box:hover {
    transform: translateY(-3px);
    box-shadow: 0 16px 40px rgba(31,41,55,.14), inset 0 1px 0 rgba(255,255,255,.8);
  }
  .card { position: relative; overflow: hidden; }
  .card::before {
    content: ''; position: absolute; top: -30px; right: -30px; width: 90px; height: 90px;
    border-radius: 50%; background: var(--dot-color, var(--accent-blue)); opacity: .12; pointer-events: none;
  }
  .card .label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; display: flex; align-items: center; gap: 6px; position: relative; }
  .card .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dot-color, var(--accent-blue)); flex-shrink: 0; }
  .card .value { font-size: 32px; font-weight: 700; letter-spacing: -.025em; margin-top: 8px; line-height: 1.05; position: relative; }
  .cards .card:nth-child(1) { animation-delay: .02s; }
  .cards .card:nth-child(2) { animation-delay: .07s; }
  .cards .card:nth-child(3) { animation-delay: .12s; }
  .cards .card:nth-child(4) { animation-delay: .17s; }
  .cards .card:nth-child(5) { animation-delay: .22s; }
  .status-online { color: var(--accent-green); }
  @keyframes pulse-dot {
    0%, 100% { box-shadow: 0 0 0 0 rgba(52,199,89,.5); }
    70% { box-shadow: 0 0 0 7px rgba(52,199,89,0); }
  }
  .cards .card:first-child .dot { animation: pulse-dot 2.2s ease-out infinite; }
  .status-offline { color: var(--accent-red); }
  .status-starting { color: var(--accent-orange); }
  .charts { display: grid; grid-template-columns: 1fr; gap: 24px; margin-bottom: 24px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
  @media (max-width: 800px) { .grid2 { grid-template-columns: 1fr; } }
  .empty-row td { color: var(--text-secondary); font-style: italic; }
  #heatmap table { border-collapse: separate; border-spacing: 3px; font-size: 11px; }
  #heatmap th { color: var(--text-secondary); font-weight: 500; padding: 2px 4px; text-align: center; }
  #heatmap td { width: 24px; height: 22px; text-align: center; color: var(--text-primary); border-radius: 5px; }
  #heatmap .weekday-label { text-align: right; color: var(--text-secondary); padding-right: 8px; white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--divider); }
  th { color: var(--text-secondary); font-weight: 500; }
  .badge { padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge-connected { background: rgba(48,209,88,.15); color: var(--accent-green); }
  .badge-disconnected { background: rgba(255,59,48,.15); color: var(--accent-red); }
  input[type="date"], select {
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    background: var(--pill-bg);
    border: 1px solid var(--glass-border);
    border-radius: 8px;
    padding: 6px 10px;
  }
  .tabs { display: inline-flex; gap: 2px; margin-bottom: 24px; padding: 3px; background: var(--pill-bg); border-radius: 12px; }
  .tab-btn, .range-btn {
    background: none;
    border: none;
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    color: var(--text-secondary);
    border-radius: 9px;
    transition: background .15s var(--ease-out), color .15s var(--ease-out), transform .1s var(--ease-out);
  }
  .tab-btn.active, .range-btn.active { color: var(--text-primary); background: var(--glass-bg); box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  /* Feedback no instante do clique (pointer-down), nao so no resultado —
     confirma na hora que a interface "ouviu" o toque. */
  .tab-btn:active, .range-btn:active { transform: scale(0.96); }
  .tab-panel { display: none; }
  .tab-panel.active {
    display: block;
    animation: fade-in .2s var(--ease-out);
  }
  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .tab-panel.active { display: block; }

  /* Aba Membros */
  /* Colunas estilo "mural": cada card tem a altura do proprio conteudo (antes, a
     grade esticava todos pra altura do maior da linha e um card pequeno ficava
     enorme e vazio). */
  .menu-grid { column-width: 320px; column-gap: 14px; }
  .menu-grid > .card, .menu-grid > .member-empty { break-inside: avoid; margin-bottom: 14px; }
  .menu-title { font-size: 15px; font-weight: 700; color: var(--text-primary); margin-bottom: 12px; }
  .menu-item { padding: 8px 0; border-top: 1px solid rgba(60,60,67,.08); }
  .menu-item:first-of-type { border-top: none; }
  .menu-cmd { display: inline-block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; font-weight: 700; color: var(--accent-blue); background: rgba(0,122,255,.1); padding: 2px 8px; border-radius: 8px; }
  .menu-desc { font-size: 13px; color: var(--text-secondary); margin-top: 4px; }
  .menu-birthday { display: flex; gap: 10px; align-items: baseline; padding: 5px 8px; margin: 0 -8px; border-radius: 10px; font-size: 13px; color: var(--text-primary); }
  .menu-birthday { align-items: center; }
  .menu-birthday .avatar-mini, .menu-birthday .avatar-fallback { width: 30px; height: 30px; font-size: 11px; box-shadow: 0 0 0 2px #fff, 0 2px 6px rgba(0,0,0,.12); }
  .avatar-unknown { display: flex; align-items: center; justify-content: center; background: #c7c7cc; color: #fff; font-weight: 800; }
  .bday-name { display: flex; flex-direction: column; min-width: 0; }
  .bday-name small { font-size: 11px; font-weight: 500; color: var(--text-secondary); margin-top: 1px; }
  .menu-birthday .when { margin-left: auto; font-size: 11px; font-weight: 600; color: var(--text-secondary); white-space: nowrap; }
  .menu-birthday.past { opacity: .42; }
  .menu-birthday.next { background: linear-gradient(90deg, rgba(0,122,255,.16), rgba(175,82,222,.16)); font-weight: 700; padding-top: 8px; padding-bottom: 8px; }
  .menu-birthday.next .when { color: var(--accent-blue); }
  .menu-birthday.today { background: rgba(255,204,0,.28); font-weight: 800; padding-top: 8px; padding-bottom: 8px; }
  .menu-birthday.today .when { color: #b25e00; }
  .bday-next { border-radius: 16px; padding: 14px 16px; margin: 12px 0 4px; color: #fff; background: linear-gradient(135deg, #2F8BFF, #8F6BFF); box-shadow: 0 8px 22px rgba(80,100,255,.28); }
  .bday-next.is-today { background: linear-gradient(135deg, #ffb300, #ff7a00); box-shadow: 0 8px 22px rgba(255,140,0,.3); }
  .bday-next .lbl { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; opacity: .85; }
  .bday-next .nm { font-size: 20px; font-weight: 800; margin-top: 2px; }
  .bday-next .dt { font-size: 13px; font-weight: 600; opacity: .92; margin-top: 2px; }
  .menu-date { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 700; color: var(--text-secondary); min-width: 38px; }
  .admin-only { display: none !important; }
  body.is-admin .admin-only { display: revert !important; }
  .danger-btn, .action-btn { font-family: inherit; font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 12px; border: 1px solid rgba(60,60,67,.14); background: rgba(255,255,255,.7); color: var(--text-primary); cursor: pointer; }
  .danger-btn { color: #d70015; border-color: rgba(215,0,21,.25); }
  .danger-btn:active, .action-btn:active { transform: scale(0.96); }
  .chip-del { border: none; background: none; color: #d70015; font-size: 14px; font-weight: 700; padding: 0 0 0 6px; cursor: pointer; }
  .log-box { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.5; color: var(--text-primary); background: rgba(255,255,255,.55); border-radius: 12px; padding: 12px; max-height: 360px; overflow: auto; white-space: pre-wrap; word-break: break-all; margin-top: 12px; }
  .rsvp-row { display: flex; gap: 8px; margin-top: 14px; }
  .rsvp-btn { flex: 1; font-family: inherit; font-size: 14px; font-weight: 700; padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(60,60,67,.14); background: rgba(255,255,255,.7); color: var(--text-primary); cursor: pointer; }
  .rsvp-btn:active { transform: scale(0.97); }
  .rsvp-btn.on-going { background: #34c759; border-color: #34c759; color: #fff; }
  .rsvp-btn.on-not { background: #ff3b30; border-color: #ff3b30; color: #fff; }
  .people-list { font-size: 13px; color: var(--text-primary); margin-top: 6px; }
  .bday-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid rgba(60,60,67,.08); flex-wrap: wrap; }
  .bday-row:first-child { border-top: none; }
  .bday-row .who { flex: 1; min-width: 150px; font-size: 14px; font-weight: 600; }
  .bday-row .who small { display: block; font-size: 11px; font-weight: 500; color: var(--text-secondary); }
  .bday-row select { font-family: inherit; font-size: 13px; padding: 7px 8px; border-radius: 10px; border: 1px solid rgba(60,60,67,.18); background: rgba(255,255,255,.8); max-width: 100%; }
  .bday-row .tag { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
  .tag-manual { background: rgba(0,122,255,.14); color: var(--accent-blue); }
  .tag-auto { background: rgba(52,199,89,.16); color: #1f8f3d; }
  .tag-none { background: rgba(255,59,48,.12); color: #d70015; }
  .menu-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .member-search { width: 100%; max-width: 320px; font-size: 14px; font-family: inherit; padding: 10px 14px; border-radius: 12px; border: 1px solid rgba(60,60,67,.14); background: rgba(255,255,255,.7); color: var(--text-primary); outline: none; margin-bottom: 20px; transition: border-color .15s var(--ease-out), box-shadow .15s var(--ease-out); }
  .member-search:focus { border-color: var(--accent-blue); box-shadow: 0 0 0 4px rgba(0,122,255,.14); }
  .member-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
  /* Sem backdrop-filter aqui de proposito — com muitos membros na grade,
     um blur POR CARD (dezenas de camadas desfocadas ao mesmo tempo) deixa a
     aba muito pesada pra renderizar. Fundo solido simula o "vidro" sem esse
     custo, que so vale a pena quando tem 1-2 elementos na tela (ex: modal). */
  .member-card {
    cursor: pointer; display: flex; align-items: center; gap: 12px;
    background: rgba(255,255,255,.72);
    border: 1px solid var(--glass-border); border-radius: var(--radius-lg); box-shadow: 0 4px 16px rgba(31,41,55,.08);
    padding: 14px; transition: transform .15s var(--ease-out), box-shadow .15s var(--ease-out), background .15s var(--ease-out);
  }
  .member-card:hover { background: rgba(255,255,255,.88); transform: translateY(-2px); box-shadow: 0 12px 30px rgba(31,41,55,.14); }
  .member-card:active { transform: scale(0.98); }
  .member-card .avatar-mini, .member-card .avatar-fallback { width: 44px; height: 44px; font-size: 15px; }
  .member-card-name { font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .member-card-sub { font-size: 12px; color: var(--text-secondary); margin-top: 1px; }
  .member-empty { color: var(--text-secondary); font-size: 13px; padding: 20px 0; }

  /* Modal de detalhes do membro */
  /* "body > :not(.blob)" (acima) tambem bate nesse elemento (e filho direto
     do body, adicionado via appendChild) com a MESMA especificidade — "body
     > .modal-overlay" empata nisso e, vindo depois no arquivo, vence. */
  body > .modal-overlay { position: fixed; inset: 0; z-index: 50; background: rgba(20,20,25,.32); display: flex; align-items: center; justify-content: center; padding: 20px; animation: fade-in .15s var(--ease-out); }
  .modal-card {
    width: 100%; max-width: 980px; max-height: 92vh; overflow-y: auto; box-sizing: border-box;
    background: rgba(255,255,255,.82); backdrop-filter: blur(32px) saturate(180%); -webkit-backdrop-filter: blur(32px) saturate(180%);
    border: 1px solid var(--glass-border); border-radius: 22px; box-shadow: 0 24px 64px rgba(31,41,55,.28), inset 0 1px 0 rgba(255,255,255,.8);
    padding: 32px; animation: fade-up .25s var(--ease-out);
  }
  .modal-close { float: right; width: 28px; height: 28px; border-radius: 50%; border: none; cursor: pointer; background: rgba(118,118,128,.14); color: var(--text-secondary); font-size: 14px; font-weight: 700; line-height: 28px; text-align: center; }
  .modal-header { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; clear: both; }
  .modal-header .avatar-mini, .modal-header .avatar-fallback { width: 76px; height: 76px; font-size: 26px; box-shadow: 0 6px 16px rgba(0,0,0,.12); }
  .modal-header-name { font-size: 24px; font-weight: 800; letter-spacing: -.01em; }
  .modal-header-sub { font-size: 12.5px; color: var(--text-secondary); margin-top: 2px; }
  .modal-section-label { font-size: 12px; font-weight: 700; color: var(--text-secondary); margin-bottom: 8px; text-transform: uppercase; letter-spacing: .04em; }
  .modal-totals { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 10px; margin-bottom: 18px; }
  .modal-totals > div { background: rgba(255,255,255,.6); border: 1px solid var(--glass-border); border-radius: 14px; padding: 12px; }
  .modal-totals .n { font-size: 28px; font-weight: 800; margin-top: 2px; }
  .podium-row { display: flex; gap: 10px; margin-bottom: 20px; }
  .podium-chip { flex: 1; display: flex; align-items: center; gap: 8px; border-radius: 12px; padding: 10px 12px; }
  .podium-chip .medal { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 11px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .podium-chip .n { font-size: 18px; font-weight: 800; }
  .podium-gold { background: rgba(255,214,0,.14); } .podium-gold .medal { background: #e8b400; }
  .podium-silver { background: rgba(142,142,147,.14); } .podium-silver .medal { background: #9a9ca0; }
  .podium-bronze { background: rgba(205,127,50,.14); } .podium-bronze .medal { background: #c97a3d; }
  .mini-heatmap-scroll { overflow-x: auto; margin-bottom: 12px; padding-bottom: 4px; }
  .mini-heatmap { display: flex; flex-direction: column; gap: 3px; min-width: 700px; }
  .mini-heatmap-row { display: flex; align-items: center; gap: 6px; }
  .mini-heatmap-row .wd { width: 34px; font-size: 12px; font-weight: 600; color: var(--text-secondary); flex-shrink: 0; }
  .mini-heatmap-row .tot { width: 40px; text-align: right; font-size: 12px; font-weight: 700; color: var(--text-primary); flex-shrink: 0; }
  .mini-heatmap-row.head .wd, .mini-heatmap-row.head .tot { height: auto; }
  .mini-heatmap-cells { display: flex; gap: 2px; flex: 1; }
  .mini-heatmap-cells > div { flex: 1; min-width: 0; height: 30px; border-radius: 5px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .mini-heatmap-cells > div.hot { color: #fff; }
  .mini-heatmap-row.head .mini-heatmap-cells > div { height: auto; font-size: 10px; font-weight: 600; color: var(--text-secondary); }
  .modal-peaks { display: flex; gap: 18px; margin-bottom: 22px; font-size: 14px; color: var(--text-secondary); }
  .modal-peaks b { color: var(--text-primary); }
  .trend-sparkline { display: flex; align-items: flex-end; gap: 4px; background: rgba(255,255,255,.5); border-radius: 10px; padding: 10px 8px 6px; box-sizing: border-box; }
  .trend-bar { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .trend-bar .n { font-size: 12px; font-weight: 700; color: var(--text-secondary); }
  .trend-bar .bar { width: 100%; min-height: 2px; border-radius: 3px; background: linear-gradient(180deg, var(--accent-blue), var(--accent-purple)); }
  .trend-bar .d { font-size: 11px; color: var(--text-secondary); white-space: nowrap; }
</style>
</head>
<body>
  <div class="blob blob-1"></div>
  <div class="blob blob-2"></div>
  <div class="glass topbar">
    <div class="brand">
      <img src="/bot-photo.png" alt="Bothierry" class="brand-photo" />
      <div>
        <div class="eyebrow">Painel</div>
        <h1>Bothierry</h1>
      </div>
    </div>

    <div class="tabs" style="margin-bottom:0;">
      <button class="tab-btn active" data-tab="overview">Visão geral</button>
      <button class="tab-btn" data-tab="activity">Atividade</button>
      <button class="tab-btn" data-tab="members">Membros</button>
      <button class="tab-btn" data-tab="menu">Comandos</button>
      <button class="tab-btn" data-tab="events">Eventos</button>
      <button class="tab-btn" data-tab="system">Sistema</button>
      <button class="tab-btn" data-tab="server">Servidor</button>
    </div>

    <div class="header-status">
      <div class="live-pill"><span class="live-dot" id="headerLiveDot"></span><span id="headerLiveLabel">Online agora</span></div>
      <a href="/logout" class="logout-link" title="Sair">Sair</a>
    </div>
  </div>

  <div id="tab-overview" class="tab-panel active">
  <div class="sub">Status do bot agora e volume de mensagens de hoje · atualiza a cada 5s</div>

  <div class="charts">
    <div class="chart-box">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
        <div class="section-head" style="margin-bottom:0;">
          <div class="title">Mensagens por Hora</div>
          <span class="label subtitle">Visão hora a hora, mostrando no topo o usuário que mais enviou mensagens no período</span>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <label for="chartDate" class="label">Data:</label>
          <input type="date" id="chartDate" />
        </div>
      </div>
      <div class="chart-scroll">
        <div class="chart-scroll-inner">
          <div id="hourChampions" class="hour-champions"></div>
          <canvas id="messagesChart" height="80"></canvas>
        </div>
      </div>
    </div>
  </div>

  <div class="charts">
    <div class="chart-box">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
        <div>
          <div class="title">Ranking</div>
          <span class="label subtitle" id="rankingSubtitle">Dia: — · Total de mensagens: —</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <div class="tabs" id="rankingToggle" style="margin-bottom:0;">
            <button class="range-btn active" data-range="expediente">Expediente (08h-18h)</button>
            <button class="range-btn" data-range="completo">Dia completo</button>
          </div>
          <input type="date" id="rankingDate" />
        </div>
      </div>
      <div id="rankingList" class="ranking-list"></div>
    </div>
  </div>
  </div>

  <div id="tab-activity" class="tab-panel">
  <div class="sub">Quem está mais ativo no grupo e em que horários · atualiza a cada 5s</div>

  <div class="charts">
    <div class="chart-box">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
        <div>
          <div class="title">Tendência de mensagens por pessoa</div>
          <div class="label subtitle">Top participantes do período — mensagens por dia</div>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <label for="trendDays" class="label">Período:</label>
          <select id="trendDays">
            <option value="7">Últimos 7 dias</option>
            <option value="14" selected>Últimos 14 dias</option>
            <option value="30">Últimos 30 dias</option>
          </select>
        </div>
      </div>
      <canvas id="trendChart" height="90"></canvas>
    </div>
  </div>

  <div class="charts">
    <div class="chart-box">
      <div class="section-head">
        <div class="title">Mapa de calor — horário de pico</div>
        <span class="label subtitle">Mensagens por dia da semana x hora, em todo o histórico do grupo</span>
      </div>
      <div id="heatmap" style="overflow-x:auto;"></div>
    </div>
  </div>
  </div>

  <div id="tab-members" class="tab-panel">
  <div class="sub">Todas as pessoas do grupo, em ordem de mensagens hoje (quem não falou fica por último) · clique em alguém pra ver os detalhes</div>
  <input type="text" id="memberSearch" class="member-search" placeholder="Buscar por nome..." />
  <div id="memberGrid" class="member-grid"></div>
  </div>

  <div id="tab-menu" class="tab-panel">
  <div class="sub">Todos os comandos do bot · mande no grupo começando com ! (ou /)</div>
  <input type="text" id="menuSearch" class="member-search" placeholder="Buscar comando..." />
  <div id="menuGrid" class="menu-grid"></div>
  </div>

  <div id="tab-events" class="tab-panel">
  <div class="sub" id="eventsSub">Próximos eventos do grupo</div>
  <div id="eventsGrid" class="menu-grid"></div>
  </div>

  <div id="tab-system" class="tab-panel">
  <div class="sub">Saúde técnica do bot — use pra investigar quando algo der errado · atualiza a cada 5s</div>

  <div class="cards">
    <div class="card"><div class="label"><span class="dot" style="--dot-color:var(--accent-green)"></span>Status agora</div><div class="value" id="status">—</div></div>
    <div class="card"><div class="label"><span class="dot" style="--dot-color:var(--accent-blue)"></span>Uptime (24h)</div><div class="value" id="uptime">—</div></div>
    <div class="card"><div class="label"><span class="dot" style="--dot-color:var(--accent-orange)"></span>Quedas (24h)</div><div class="value" id="disconnects">—</div></div>
    <div class="card"><div class="label"><span class="dot" style="--dot-color:var(--accent-purple)"></span>Mensagens (última hora)</div><div class="value" id="messages">—</div></div>
    <div class="card"><div class="label"><span class="dot" style="--dot-color:#8e8e93"></span>Memória (RSS)</div><div class="value" id="memory">—</div></div>
  </div>

  <div class="grid2">
    <div class="chart-box">
      <div class="section-head">
        <div class="title">Eventos de conexão recentes</div>
        <span class="label subtitle">Últimas quedas e reconexões do bot com o WhatsApp</span>
      </div>
      <div id="eventsList" class="events-list"></div>
    </div>

    <div class="chart-box">
      <div class="section-head">
        <div class="title">Erros recentes</div>
        <span class="label subtitle">Mensagens de erro registradas pelo bot</span>
      </div>
      <table>
        <thead><tr><th>Quando</th><th>Mensagem</th></tr></thead>
        <tbody id="errorsBody"></tbody>
      </table>
    </div>
  </div>

  <div class="grid2">
    <div class="chart-box">
      <div class="section-head">
        <div class="title">Comandos mais usados</div>
        <span class="label subtitle">Comandos mais executados pelo grupo nas últimas 24h</span>
      </div>
      <table>
        <thead><tr><th>Comando</th><th>Vezes</th></tr></thead>
        <tbody id="commandsBody"></tbody>
      </table>
    </div>

    <div class="chart-box">
      <div class="section-head">
        <div class="title">Última execução dos crons</div>
        <span class="label subtitle">Quando cada tarefa agendada rodou pela última vez</span>
      </div>
      <table>
        <thead><tr><th>Tarefa</th><th>Última vez</th></tr></thead>
        <tbody id="cronsBody"></tbody>
      </table>
    </div>
  </div>
  <div class="chart-box admin-only" style="margin-top:16px;">
    <div class="section-head">Ações</div>
    <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
      <button class="danger-btn" id="restartBtn">Reiniciar bot</button>
      <span class="menu-desc" id="actionMsg" style="margin:0;"></span>
    </div>
    <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:18px;">
      <div class="section-head" style="margin:0;">Logs</div>
      <select id="logKind"><option value="out">Saída</option><option value="error">Erros</option></select>
      <button class="action-btn" id="logRefresh">Atualizar</button>
    </div>
    <div class="log-box" id="logBox">Clique em Atualizar.</div>
  </div>
  <div class="chart-box admin-only" style="margin-top:16px;">
    <div class="section-head">Aniversariantes e fotos</div>
    <div class="menu-desc" style="margin:0 0 12px;">Escolha qual membro é cada aniversariante, pra foto dele sair no cartão de aniversário. "Automático" usa o nome (só quando bate com uma pessoa só).</div>
    <div id="bdayLinks">Carregando...</div>
  </div>
  </div>

  <div id="tab-server" class="tab-panel">
  <div class="sub">Uso de recursos da máquina (VM) onde o bot roda · atualiza a cada 5s</div>

  <div class="cards">
    <div class="card"><div class="label"><span class="dot" style="--dot-color:var(--accent-blue)"></span>CPU</div><div class="value" id="cpuPercent">—</div></div>
    <div class="card"><div class="label"><span class="dot" style="--dot-color:var(--accent-green)"></span>Memória</div><div class="value" id="memPercent">—</div></div>
    <div class="card"><div class="label"><span class="dot" style="--dot-color:var(--accent-purple)"></span>Armazenamento</div><div class="value" id="diskPercent">—</div></div>
    <div class="card"><div class="label"><span class="dot" style="--dot-color:#8e8e93"></span>Núcleos de CPU</div><div class="value" id="cpuCores">—</div></div>
  </div>

  <div class="charts">
    <div class="chart-box">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
        <div>
          <div class="title">Histórico de uso</div>
          <div class="label subtitle">CPU e memória ao longo do tempo</div>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <label for="systemHistoryHours" class="label">Período:</label>
          <select id="systemHistoryHours">
            <option value="6">Últimas 6h</option>
            <option value="24" selected>Últimas 24h</option>
            <option value="168">Últimos 7 dias</option>
          </select>
        </div>
      </div>
      <canvas id="systemHistoryChart" height="80"></canvas>
    </div>
  </div>
  </div>

<script>
document.querySelectorAll('.tabs:not(#rankingToggle) > .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs:not(#rankingToggle) > .tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    // Chart.js mede o canvas no momento em que ele e criado — se a aba
    // "Atividade" nunca tiver sido aberta antes, o canvas do trendChart
    // nasce com largura 0 (container escondido). Um resize() ao abrir a
    // aba corrige isso, recalculando o tamanho com o container ja visivel.
    if (btn.dataset.tab === 'activity' && trendChart) trendChart.resize();
    if (btn.dataset.tab === 'server' && systemHistoryChart) systemHistoryChart.resize();
    if (btn.dataset.tab === 'members') loadMembers();
    if (btn.dataset.tab === 'menu') loadMenu();
    if (btn.dataset.tab === 'events') loadEvents();
  });
});
let chart;

function fmtTime(ts) {
  return new Date(ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit' });
}

function todayBR() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

// Plugin custom do Chart.js — desenha, acima de cada barra que teve
// mensagem, a foto (ou iniciais, se nao tiver foto) e o primeiro nome de
// quem mais mandou mensagem naquela hora. O datalabels (numero) so faz
// texto, por isso isso aqui e um plugin a parte, desenhando direto no
// canvas via drawImage/arc.
// So o numero, perto do topo de cada barra — a foto/coroa/nome de quem mais
// mandou mensagem naquela hora NAO fica mais desenhada no canvas (ficava
// "flutuando" por cima do grafico); agora e uma fileira HTML de verdade,
// ACIMA do grafico inteiro (ver renderHourChampions / .hour-champions).
const HOUR_LABEL_GAP = 14;

// Posiciona cada .hour-champion exatamente em cima do centro da barra
// correspondente, usando a coordenada x real que o Chart.js calculou — nao
// uma estimativa de largura fixa, que desalinha quando o grafico redimensiona
// ou quando o eixo Y muda de largura (numeros com mais digitos etc).
function positionHourChampions(chartInstance) {
  const meta = chartInstance.getDatasetMeta(0);
  const container = document.getElementById('hourChampions');
  const cells = container.querySelectorAll('.hour-champion');
  meta.data.forEach((bar, i) => {
    const cell = cells[i];
    if (!cell) return;
    const { x } = bar.getProps(['x'], true);
    cell.style.left = x + 'px';
  });
}

const topSenderAvatarsPlugin = {
  id: 'topSenderAvatars',
  afterDatasetsDraw(chartInstance) {
    const meta = chartInstance.getDatasetMeta(0);
    const ctx = chartInstance.ctx;
    const counts = chartInstance.data.datasets[0].data;

    meta.data.forEach((bar, i) => {
      const count = counts[i];
      if (!count) return;
      const { x, y } = bar.getProps(['x', 'y'], true);
      ctx.save();
      ctx.font = '700 12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = '#1d1d1f';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(String(count), x, y - HOUR_LABEL_GAP);
      ctx.restore();
    });
  },
  // Roda sempre que o Chart.js recalcula o layout — tanto em refresh de dado
  // quanto em resize da janela (responsive:true chama resize() internamente,
  // que tambem dispara update) — assim a fileira nunca fica desalinhada.
  afterUpdate(chartInstance) {
    positionHourChampions(chartInstance);
  },
};

// Monta a fileira HTML (fora do canvas, acima do grafico) com foto + coroa +
// primeiro nome de quem mais mandou mensagem em cada hora do dia.
function renderHourChampions(hourKeys, topSenderPerHour) {
  const el = document.getElementById('hourChampions');
  el.innerHTML = hourKeys
    .map((h) => {
      const top = topSenderPerHour[h];
      if (!top) return '<div class="hour-champion"></div>';
      return (
        '<div class="hour-champion">' +
        '<span class="crown">👑</span>' +
        avatarImg(top.jid, top.senderName, 'avatar-mini') +
        '<span class="name">' + escapeHtml(top.senderName.split(' ')[0]) + '</span>' +
        '</div>'
      );
    })
    .join('');
}

async function refreshChart(date) {
  const res = await fetch('/api/messages-per-hour?date=' + date);
  const data = await res.json();

  const hourKeys = Object.keys(data.hours).sort();
  const labels = hourKeys.map((h) => h + 'h');
  const counts = hourKeys.map((h) => data.hours[h]);

  if (!chart) {
    chart = new Chart(document.getElementById('messagesChart'), {
      type: 'bar',
      plugins: [topSenderAvatarsPlugin],
      data: {
        labels,
        datasets: [
          {
            label: 'Mensagens',
            data: counts,
            // Gradiente vertical (verde Apple no topo, esmaecendo pra baixo)
            // em vez de cor solida "chapada" — reavaliado a cada redesenho,
            // ja que a area do grafico so existe depois do primeiro layout.
            // Mesmo gradiente azul->roxo da barra de progresso do Ranking,
            // pra padronizar as cores entre os dois cards.
            backgroundColor(context) {
              const { ctx: c, chartArea } = context.chart;
              if (!chartArea) return '#007aff';
              const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
              gradient.addColorStop(0, '#007aff');
              gradient.addColorStop(1, '#af52de');
              return gradient;
            },
            borderRadius: { topLeft: 8, topRight: 8, bottomLeft: 3, bottomRight: 3 },
            borderSkipped: false,
          },
        ],
      },
      options: {
        responsive: true,
        animation: false, // atualiza sozinho a cada 5s — reanimar toda vez cansa visualmente
        // Espaco extra no topo pro numero da barra mais alta nao cortar na borda.
        layout: { padding: { top: 24 } },
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#8e8e93' }, grid: { color: 'rgba(142,142,147,.15)' }, title: { display: true, text: 'Hora do dia', color: '#8e8e93' } },
          y: { ticks: { color: '#8e8e93' }, grid: { color: 'rgba(142,142,147,.15)' }, beginAtZero: true, title: { display: true, text: 'Mensagens', color: '#8e8e93' } },
        },
      },
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets[0].data = counts;
  }
  renderHourChampions(hourKeys, data.topSenderPerHour);
  chart.update();
}

document.getElementById('chartDate').value = todayBR();
document.getElementById('chartDate').max = todayBR();
refreshChart(todayBR());
document.getElementById('chartDate').addEventListener('change', (e) => {
  if (e.target.value) refreshChart(e.target.value);
});

// Paleta com cores bem distintas entre si (nao graduais), pra diferenciar
// ate 8 linhas no mesmo grafico sem confundir visualmente.
const TREND_COLORS = ['#1a9d68', '#2563eb', '#dc2626', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

let trendChart;

async function refreshTrend(days) {
  const res = await fetch('/api/trend?days=' + days);
  const data = await res.json();

  const labels = data.dates.map((d) => {
    const [, m, day] = d.split('-');
    return day + '/' + m;
  });
  const datasets = data.series.map((s, i) => ({
    label: s.name,
    data: s.data,
    borderColor: TREND_COLORS[i % TREND_COLORS.length],
    backgroundColor: TREND_COLORS[i % TREND_COLORS.length],
    tension: 0.25,
    pointRadius: 2,
  }));

  if (!trendChart) {
    trendChart = new Chart(document.getElementById('trendChart'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        animation: false, // atualiza sozinho a cada 5s — reanimar toda vez cansa visualmente
        plugins: { legend: { position: 'bottom', labels: { color: '#8e8e93', boxWidth: 12 } } },
        scales: {
          x: { ticks: { color: '#8e8e93' }, grid: { color: 'rgba(142,142,147,.15)' } },
          y: { ticks: { color: '#8e8e93' }, grid: { color: 'rgba(142,142,147,.15)' }, beginAtZero: true, title: { display: true, text: 'Mensagens', color: '#8e8e93' } },
        },
      },
    });
  } else {
    trendChart.data.labels = labels;
    trendChart.data.datasets = datasets;
    trendChart.update();
  }
}

const trendDaysEl = document.getElementById('trendDays');
refreshTrend(trendDaysEl.value);
trendDaysEl.addEventListener('change', (e) => refreshTrend(e.target.value));

// Verde mais forte quanto maior o valor, relativo ao maximo da matriz inteira
// (nao por linha/coluna), pra comparar horarios entre si de forma justa.
function heatColor(value, max) {
  if (value === 0 || max === 0) return '#f9fafb';
  const intensity = value / max;
  const lightness = 92 - Math.round(intensity * 62); // 92% (quase branco) ate 30% (verde forte)
  return 'hsl(152, 55%, ' + lightness + '%)';
}

async function refreshHeatmap() {
  const res = await fetch('/api/heatmap');
  const data = await res.json();
  if (!data.matrix || data.matrix.length === 0) {
    document.getElementById('heatmap').innerHTML = '<div class="label">Sem dados suficientes ainda.</div>';
    return;
  }

  const max = Math.max(...data.matrix.flat());
  const hourHeaders = Array.from({ length: 24 }, (_, h) => '<th>' + h + '</th>').join('');
  const rows = data.matrix
    .map((row, dayIdx) => {
      const cells = row
        .map((value) => '<td style="background:' + heatColor(value, max) + '" title="' + value + ' mensagens">' + (value > 0 ? value : '') + '</td>')
        .join('');
      return '<tr><td class="weekday-label">' + data.weekdayNames[dayIdx] + '</td>' + cells + '</tr>';
    })
    .join('');

  document.getElementById('heatmap').innerHTML =
    '<table><thead><tr><th></th>' + hourHeaders + '</tr></thead><tbody>' + rows + '</tbody></table>';
}

refreshHeatmap();
setInterval(refreshHeatmap, 30000);

async function refreshServerCards() {
  const res = await fetch('/api/system');
  const data = await res.json();

  document.getElementById('cpuPercent').textContent = data.cpu.usedPercent + '%';
  document.getElementById('memPercent').textContent = data.memory.usedPercent + '% (' + data.memory.usedMb + ' MB)';
  document.getElementById('cpuCores').textContent = data.cpu.cores;
  document.getElementById('diskPercent').textContent = data.disk
    ? data.disk.usedPercent + '% (' + data.disk.usedGb + ' de ' + data.disk.totalGb + ' GB)'
    : 'indisponível';
}

let systemHistoryChart;

async function refreshSystemHistory(hours) {
  const res = await fetch('/api/system-history?hours=' + hours);
  const points = await res.json();

  const labels = points.map((p) => new Date(p.ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }));
  const cpuData = points.map((p) => p.cpuPercent);
  const memData = points.map((p) => p.memPercent);

  const datasets = [
    { label: 'CPU %', data: cpuData, borderColor: '#007aff', backgroundColor: '#007aff', tension: 0.25, pointRadius: 0 },
    { label: 'Memória %', data: memData, borderColor: '#34c759', backgroundColor: '#34c759', tension: 0.25, pointRadius: 0 },
  ];

  if (!systemHistoryChart) {
    systemHistoryChart = new Chart(document.getElementById('systemHistoryChart'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        animation: false, // atualiza sozinho a cada 5s — reanimar toda vez cansa visualmente
        plugins: { legend: { position: 'bottom', labels: { color: '#8e8e93', boxWidth: 12 } } },
        scales: {
          x: { ticks: { color: '#8e8e93', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, grid: { color: 'rgba(142,142,147,.15)' } },
          y: { ticks: { color: '#8e8e93' }, grid: { color: 'rgba(142,142,147,.15)' }, beginAtZero: true, max: 100, title: { display: true, text: '%', color: '#8e8e93' } },
        },
      },
    });
  } else {
    systemHistoryChart.data.labels = labels;
    systemHistoryChart.data.datasets = datasets;
    systemHistoryChart.update();
  }
}

refreshServerCards();
setInterval(refreshServerCards, 15000);

const systemHistoryHoursEl = document.getElementById('systemHistoryHours');
refreshSystemHistory(systemHistoryHoursEl.value);
systemHistoryHoursEl.addEventListener('change', (e) => refreshSystemHistory(e.target.value));
setInterval(() => refreshSystemHistory(systemHistoryHoursEl.value), 30000);

async function refresh() {
  const res = await fetch('/api/metrics');
  const data = await res.json();

  const statusEl = document.getElementById('status');
  const statusLabel = { connected: 'Online', disconnected: 'Offline', starting: 'Iniciando' }[data.currentStatus] || data.currentStatus;
  const statusClass = { connected: 'status-online', disconnected: 'status-offline', starting: 'status-starting' }[data.currentStatus] || '';
  statusEl.textContent = statusLabel;
  statusEl.className = 'value ' + statusClass;

  const headerDotColor = { connected: 'var(--accent-green)', disconnected: 'var(--accent-red)', starting: 'var(--accent-orange)' }[data.currentStatus] || 'var(--accent-green)';
  document.getElementById('headerLiveDot').style.background = headerDotColor;
  document.getElementById('headerLiveLabel').textContent = data.currentStatus === 'connected' ? 'Online agora' : statusLabel;

  document.getElementById('uptime').textContent = data.uptimePercent + '%';
  document.getElementById('disconnects').textContent = data.disconnectsLast24h;
  document.getElementById('messages').textContent = data.messagesLastHour;

  document.getElementById('memory').textContent = data.memory.rssMb + ' MB';

  const eventsList = document.getElementById('eventsList');
  eventsList.innerHTML = data.recentEvents.length
    ? data.recentEvents
        .map((e) => {
          const badgeClass = e.status === 'connected' ? 'badge-connected' : 'badge-disconnected';
          const badgeLabel = e.status === 'connected' ? 'Conectou' : 'Caiu';
          const detail = e.status === 'disconnected'
            ? (e.willReconnect ? 'Reconectando em ' + Math.round((e.nextDelayMs || 0) / 1000) + 's' : 'Sessão deslogada')
            : 'Conexão reestabelecida';
          return (
            '<div class="events-row">' +
            '<span class="badge ' + badgeClass + '">' + badgeLabel + '</span>' +
            '<div class="events-detail">' + detail + '</div>' +
            '<div class="events-time">' + fmtTime(e.ts) + '</div>' +
            '</div>'
          );
        })
        .join('')
    : '<div class="label" style="font-style:italic;">Nenhum evento ainda</div>';

  const commandsBody = document.getElementById('commandsBody');
  commandsBody.innerHTML = data.topCommands.length
    ? data.topCommands.map((c) => '<tr><td>!' + c.name + '</td><td>' + c.count + '</td></tr>').join('')
    : '<tr class="empty-row"><td colspan="2">Nenhum comando usado ainda</td></tr>';

  const CRON_LABELS = {
    archive: 'Arquivamento de mensagens',
    aniversario: 'Checagem de aniversário',
    foto_bot_tema: 'Foto temática do bot',
    bom_dia: 'Mensagem de bom dia',
    propaganda: 'Propaganda (#ad) das 22h30',
    fim_expediente: 'Mensagem de fim de expediente',
    foto_grupo_noticia: 'Foto do grupo (notícia)',
    ranking_semanal: 'Ranking semanal',
  };
  const cronsBody = document.getElementById('cronsBody');
  const cronRows = Object.entries(CRON_LABELS).map(([key, label]) => {
    const ts = data.cronLastRuns[key];
    return '<tr><td>' + label + '</td><td>' + (ts ? fmtTime(ts) : '— ainda não rodou') + '</td></tr>';
  });
  cronsBody.innerHTML = cronRows.join('');

  const errorsBody = document.getElementById('errorsBody');
  errorsBody.innerHTML = data.recentErrors.length
    ? data.recentErrors
        .slice(0, 15)
        .map((e) => '<tr><td>' + fmtTime(e.ts) + '</td><td>' + escapeHtml(e.message) + '</td></tr>')
        .join('')
    : '<tr class="empty-row"><td colspan="2">Nenhum erro registrado 🎉</td></tr>';
}

function fmtDateBR(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return d + '/' + m + '/' + y;
}

const RANKING_RANGES = {
  expediente: { endpoint: '/api/ranking', emptyMsg: 'Nenhuma mensagem ainda hoje entre 08h e 18h' },
  completo: { endpoint: '/api/ranking-full', emptyMsg: 'Nenhuma mensagem ainda hoje' },
};
let rankingRange = 'expediente';

// Escapa texto vindo de fora (nome de exibicao do WhatsApp, 100% controlado
// por quem manda mensagem no grupo) antes de colocar em innerHTML — sem
// isso, alguem poderia configurar o proprio nome como "<img
// onerror=...>" e rodar script no navegador de quem abre o painel (XSS
// armazenado). Nunca confie em texto de usuario indo direto pro HTML.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// Letras do nome pra mostrar num circulo colorido quando a pessoa nao tem
// foto de perfil cacheada (ou bloqueou por privacidade) — nunca deixa a
// celula vazia/quebrada.
function initials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
}

// Troca a propria tag <img> pelo circulo de iniciais quando a foto falha ao
// carregar (404 — sem foto cacheada) — funcao global chamada pelo onerror,
// em vez de montar o fallback como string HTML dentro do atributo (isso
// quebrava o HTML: JSON.stringify usa aspas duplas, que colidiam com as
// aspas duplas do proprio atributo onerror="...").
function avatarFallback(img) {
  const div = document.createElement('div');
  div.className = 'avatar-fallback';
  div.textContent = img.dataset.initials || '';
  img.replaceWith(div);
}

function avatarImg(jid, name, cls) {
  const src = '/avatar?jid=' + encodeURIComponent(jid);
  return '<img class="' + cls + '" src="' + src + '" alt="" data-initials="' + escapeHtml(initials(name)) + '" onerror="avatarFallback(this)" />';
}

function personCell(jid, name) {
  return '<div class="person">' + avatarImg(jid, name, 'avatar-mini') + '<span>' + escapeHtml(name) + '</span></div>';
}

// Aba Membros — lista carregada uma vez (sob demanda, na primeira vez que a
// aba abre) e filtrada so no navegador, sem bater no servidor a cada letra
// digitada na busca.
let allMembers = null;

let membersLoadedAt = 0;

async function loadMembers() {
  // A ordem depende das mensagens de hoje, entao recarrega ao abrir a aba
  // (com um respiro de 30s pra nao refazer a consulta a cada clique).
  if (allMembers && Date.now() - membersLoadedAt < 30000) return;
  membersLoadedAt = Date.now();
  const res = await fetch('/api/members');
  allMembers = await res.json();
  renderMemberGrid(allMembers);
}

function renderMemberGrid(members) {
  const grid = document.getElementById('memberGrid');
  if (members.length === 0) {
    grid.innerHTML = '<div class="member-empty">Nenhum membro encontrado.</div>';
    return;
  }
  grid.innerHTML = members
    .map(
      (m) =>
        '<div class="member-card" data-jid="' + escapeHtml(m.jid) + '">' +
        avatarImg(m.jid, m.name, 'avatar-mini') +
        '<div style="min-width:0;">' +
        '<div class="member-card-name">' + escapeHtml(m.name) + '</div>' +
        '<div class="member-card-sub">' + m.todayCount + ' msgs hoje</div>' +
        '</div></div>',
    )
    .join('');
}

document.getElementById('memberSearch').addEventListener('input', (e) => {
  if (!allMembers) return;
  const q = e.target.value.trim().toLowerCase();
  renderMemberGrid(q ? allMembers.filter((m) => m.name.toLowerCase().includes(q)) : allMembers);
});

// Delegado (em vez de onclick por card) — evita qualquer problema de escape
// de aspas ao colocar o JID (que pode ter caracteres especiais) direto num
// atributo onclick.
document.getElementById('memberGrid').addEventListener('click', (e) => {
  const card = e.target.closest('.member-card');
  if (card) openMemberModal(card.dataset.jid);
});

const WEEKDAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const HEAT_COLORS = ['rgba(0,122,255,.08)', 'rgba(0,122,255,.28)', 'rgba(0,122,255,.5)', 'rgba(0,122,255,.75)', 'rgba(0,122,255,1)'];

function heatLevel(count, max) {
  if (!max || count === 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((count / max) * 4)));
}

async function openMemberModal(jid) {
  closeMemberModal(); // evita empilhar modais se clicar em outro membro rapido
  const res = await fetch('/api/member?jid=' + encodeURIComponent(jid));
  if (!res.ok) return;
  const s = await res.json();

  const maxCell = Math.max(1, ...s.heatmap.matrix.flat());
  const hourHead =
    '<div class="mini-heatmap-row head"><div class="wd"></div><div class="mini-heatmap-cells">' +
    Array.from({ length: 24 }, (_, h) => '<div>' + h + '</div>').join('') +
    '</div><div class="tot">Total</div></div>';
  const heatmapHtml = hourHead + s.heatmap.matrix
    .map((row, d) => {
      const dayTotal = row.reduce((a, b) => a + b, 0);
      return (
        '<div class="mini-heatmap-row"><div class="wd">' + WEEKDAY_SHORT[d] + '</div><div class="mini-heatmap-cells">' +
        row.map((count, h) => {
          const level = heatLevel(count, maxCell);
          return '<div class="' + (level >= 3 ? 'hot' : '') + '" style="background:' + HEAT_COLORS[level] + '" title="' +
            WEEKDAY_SHORT[d] + ' ' + String(h).padStart(2, '0') + 'h: ' + count + ' msgs">' + (count > 0 ? count : '') + '</div>';
        }).join('') +
        '</div><div class="tot">' + dayTotal + '</div></div>'
      );
    })
    .join('');

  const maxTrend = Math.max(1, ...s.trend.counts);
  const TREND_BAR_MAX_PX = 96;
  const trendHtml = s.trend.counts
    .map((c, i) => {
      const [, m, d] = s.trend.dates[i].split('-');
      const barPx = Math.max(2, Math.round((c / maxTrend) * TREND_BAR_MAX_PX));
      return (
        '<div class="trend-bar">' +
        '<div class="n">' + c + '</div>' +
        '<div class="bar" style="height:' + barPx + 'px"></div>' +
        '<div class="d">' + d + '/' + m + '</div>' +
        '</div>'
      );
    })
    .join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) closeMemberModal(); };
  overlay.innerHTML =
    '<div class="modal-card">' +
    '<button class="modal-close" onclick="closeMemberModal()">✕</button>' +
    '<div class="modal-header">' +
    avatarImg(s.jid, s.name, 'avatar-mini') +
    '<div><div class="modal-header-name">' + escapeHtml(s.name) + '</div>' +
    '<div class="modal-header-sub">Mensurado desde ' + fmtDateBR(s.since) + '</div></div>' +
    '</div>' +
    '<div class="modal-totals">' +
    '<div><div class="label">Total</div><div class="n">' + s.total + '</div></div>' +
    '<div><div class="label">Hoje</div><div class="n">' + s.todayCount + '</div></div>' +
    '<div><div class="label">Posição hoje</div><div class="n">' + s.rankToday + '</div></div>' +
    '</div>' +
    '<div class="modal-section-label">Pódio diário (expediente, histórico)</div>' +
    '<div class="podium-row">' +
    '<div class="podium-chip podium-gold"><div class="medal">1º</div><div class="n">' + s.gold + '</div></div>' +
    '<div class="podium-chip podium-silver"><div class="medal">2º</div><div class="n">' + s.silver + '</div></div>' +
    '<div class="podium-chip podium-bronze"><div class="medal">3º</div><div class="n">' + s.bronze + '</div></div>' +
    '</div>' +
    '<div class="modal-section-label">Mapa de calor pessoal (mensagens por dia da semana e hora)</div>' +
    '<div class="mini-heatmap-scroll"><div class="mini-heatmap">' + heatmapHtml + '</div></div>' +
    '<div class="modal-peaks">' +
    '<div>Horário preferido: <b>' + String(s.peakHour).padStart(2, '0') + 'h</b></div>' +
    '<div>Dia preferido: <b>' + s.peakDayName + '</b></div>' +
    '</div>' +
    '<div class="modal-section-label">Últimos 14 dias</div>' +
    '<div class="trend-sparkline">' + trendHtml + '</div>' +
    '</div>';
  document.body.appendChild(overlay);
}

function closeMemberModal() {
  document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
}

// Papel de quem esta logado — admin ve os botoes de apagar/reiniciar/logs
// (o servidor tambem barra essas rotas pra quem nao e admin).
fetch('/api/me').then((r) => r.json()).then((me) => {
  if (me.role === 'admin') { document.body.classList.add('is-admin'); loadBdayAdmin(); }
  // Quem entrou pelo link do !painel veio pra marcar presenca: ja abre em Eventos.
  if (me.role === 'member') document.querySelector('button[data-tab=events]').click();
}).catch(() => {});

let menuData = null;

async function loadMenu() {
  if (menuData) return;
  const res = await fetch('/api/commands');
  menuData = await res.json();
  renderMenu('');
}

// Marca cada aniversariante como ja passou (este ano) / hoje / proximo / futuro,
// com quantos dias faltam (se ja passou, conta pro ano que vem — usado pra achar
// o proximo mesmo em dezembro). Data de "hoje" no fuso de Brasilia.
function birthdayInfo(birthdays) {
  const [ty, tm, td] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()).split('-').map(Number);
  const todayUtc = Date.UTC(ty, tm - 1, td);
  const list = birthdays.map((b) => {
    const thisYear = Date.UTC(ty, b.month - 1, b.day);
    const past = thisYear < todayUtc;
    const days = Math.round(((past ? Date.UTC(ty + 1, b.month - 1, b.day) : thisYear) - todayUtc) / 86400000);
    return { ...b, past, days, isToday: days === 0 };
  });
  const minDays = list.length ? Math.min(...list.map((b) => b.days)) : null;
  list.forEach((b) => { b.isNext = b.days === minDays; });
  return { list, next: list.filter((b) => b.isNext) };
}

function renderMenu(query) {
  const q = query.trim().toLowerCase().replace(/^[!/]/, '');
  const grid = document.getElementById('menuGrid');
  const blocks = [];
  menuData.categories.forEach((cat) => {
    const items = cat.commands.filter((c) => !q || c.name.includes(q) || c.description.toLowerCase().includes(q));
    // Conteudo dinamico que mora dentro do card da categoria: audios salvos
    // no card "Áudios" e a lista de aniversariantes no card "Aniversários".
    let extra = '';
    let extraCount = 0;
    if (cat.title === 'Áudios') {
      const audios = menuData.audios.filter((a) => !q || a.includes(q));
      extraCount = audios.length;
      if (audios.length > 0) {
        extra =
          '<div class="modal-section-label" style="margin-top:14px;">Áudios salvos (mande !nome pra tocar)</div>' +
          '<div class="menu-chips">' + audios.map((a) =>
            '<span class="menu-cmd">!' + escapeHtml(a) +
            (a === 'repetido' ? '' : '<button class="chip-del admin-only" data-audio="' + escapeHtml(a) + '" title="Apagar">✕</button>') +
            '</span>'
          ).join('') + '</div>';
      }
    } else if (cat.title === 'Aniversários') {
      const info = birthdayInfo(menuData.birthdays);
      const filtered = info.list.filter((b) => !q || b.name.toLowerCase().includes(q));
      extraCount = filtered.length;
      if (filtered.length > 0) {
        const pad = (n) => String(n).padStart(2, '0');
        const whenText = (b) => (b.isToday ? 'hoje 🎉' : b.days === 1 ? 'amanhã' : 'em ' + b.days + ' dias');
        let banner = '';
        if (!q && info.next.length > 0) {
          const today = info.next[0].isToday;
          const names = info.next.map((b) => escapeHtml(b.name)).join(' e ');
          const first = info.next[0];
          banner =
            '<div class="bday-next' + (today ? ' is-today' : '') + '"><div class="lbl">' + (today ? '🎉 Hoje é aniversário de' : '🎂 Próximo aniversário') + '</div>' +
            '<div class="nm">' + names + '</div>' +
            '<div class="dt">' + pad(first.day) + '/' + pad(first.month) + (today ? '' : ' · ' + (first.days === 1 ? 'amanhã' : 'em ' + first.days + ' dias')) + '</div></div>';
        }
        extra =
          banner +
          '<div class="modal-section-label" style="margin-top:14px;">Aniversariantes cadastrados</div>' +
          filtered.map((b) =>
            '<div class="menu-birthday' + (b.isToday ? ' today' : b.isNext ? ' next' : b.past ? ' past' : '') + '">' +
            '<span class="menu-date">' + pad(b.day) + '/' + pad(b.month) + '</span>' +
            (b.jid ? avatarImg(b.jid, b.member || b.name, 'avatar-mini') : '<div class="avatar-fallback avatar-unknown" title="sem membro ligado">?</div>') +
            '<span class="bday-name">' + escapeHtml(b.name) +
            (b.member && b.member.toLowerCase() !== b.name.toLowerCase() ? '<small>' + escapeHtml(b.member) + '</small>' : '') + '</span>' +
            '<span class="when">' + (b.past && !b.isNext ? '✓' : whenText(b)) + '</span></div>'
          ).join('');
      }
    }
    if (items.length === 0 && extraCount === 0) return;
    blocks.push(
      '<div class="card"><div class="menu-title">' + escapeHtml(cat.emoji) + ' ' + escapeHtml(cat.title) + '</div>' +
      items.map((c) =>
        '<div class="menu-item"><span class="menu-cmd">!' + escapeHtml(c.name) + '</span>' +
        '<div class="menu-desc">' + escapeHtml(c.description) + '</div></div>'
      ).join('') + extra + '</div>'
    );
  });
  grid.innerHTML = blocks.length ? blocks.join('') : '<div class="member-empty">Nenhum comando encontrado.</div>';
}

document.getElementById('menuSearch').addEventListener('input', (e) => {
  if (menuData) renderMenu(e.target.value);
});

document.getElementById('menuGrid').addEventListener('click', async (e) => {
  const btn = e.target.closest('.chip-del');
  if (!btn) return;
  const name = btn.dataset.audio;
  if (!confirm('Apagar o áudio !' + name + '? Não dá pra desfazer.')) return;
  try {
    const res = await fetch('/api/audios/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'panel' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!data.ok) { alert('Não apaguei: ' + (data.error || 'erro')); return; }
    menuData = null;
    await loadMenu();
  } catch {
    alert('Não consegui falar com o bot. Tenta de novo.');
  }
});

async function loadLogs() {
  const box = document.getElementById('logBox');
  box.textContent = 'Carregando...';
  try {
    const kind = document.getElementById('logKind').value;
    const res = await fetch('/api/logs?kind=' + kind + '&lines=120', { headers: { 'X-Requested-With': 'panel' } });
    const data = await res.json();
    box.textContent = data.lines && data.lines.length ? data.lines.join(String.fromCharCode(10)) : (data.error || 'Sem linhas.');
    box.scrollTop = box.scrollHeight;
  } catch {
    box.textContent = 'Não consegui carregar os logs.';
  }
}
document.getElementById('logRefresh').addEventListener('click', loadLogs);
document.getElementById('logKind').addEventListener('change', loadLogs);

document.getElementById('restartBtn').addEventListener('click', async () => {
  if (!confirm('Reiniciar o bot agora? Ele fica fora do ar por uns segundos.')) return;
  const msg = document.getElementById('actionMsg');
  try {
    const res = await fetch('/api/restart', { method: 'POST', headers: { 'X-Requested-With': 'panel' } });
    const data = await res.json();
    if (!data.ok) { msg.textContent = 'Não reiniciou: ' + (data.error || 'erro'); return; }
    msg.textContent = 'Reiniciando… a página recarrega sozinha.';
    setTimeout(() => location.reload(), 15000);
  } catch {
    msg.textContent = 'Não consegui falar com o bot.';
  }
});

async function loadBdayAdmin() {
  const box = document.getElementById('bdayLinks');
  try {
    const res = await fetch('/api/admin/birthday-links', { headers: { 'X-Requested-With': 'panel' } });
    if (!res.ok) { box.textContent = 'Não consegui carregar.'; return; }
    const data = await res.json();
    const pad = (n) => String(n).padStart(2, '0');
    box.innerHTML = data.birthdays.map((b, i) => {
      const tag = b.source === 'manual' ? '<span class="tag tag-manual">manual</span>'
        : b.source === 'auto' ? '<span class="tag tag-auto">automático</span>'
        : '<span class="tag tag-none">sem foto</span>';
      const options = '<option value="">(automático)</option>' + data.members.map((m) =>
        '<option value="' + escapeHtml(m.jid) + '"' + (b.source === 'manual' && b.jid === m.jid ? ' selected' : '') + '>' + escapeHtml(m.name) + '</option>'
      ).join('');
      const photo = b.jid ? avatarImg(b.jid, b.name, 'avatar-mini') : '';
      return '<div class="bday-row">' + photo +
        '<div class="who">' + escapeHtml(b.name) + '<small>' + pad(b.day) + '/' + pad(b.month) + '</small></div>' + tag +
        '<select data-idx="' + i + '">' + options + '</select></div>';
    }).join('');
    box.dataset.names = JSON.stringify(data.birthdays.map((b) => b.name));
  } catch {
    box.textContent = 'Não consegui carregar.';
  }
}

document.getElementById('bdayLinks').addEventListener('change', async (e) => {
  const sel = e.target.closest('select');
  if (!sel) return;
  const names = JSON.parse(document.getElementById('bdayLinks').dataset.names || '[]');
  try {
    const res = await fetch('/api/admin/birthday-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'panel' },
      body: JSON.stringify({ name: names[Number(sel.dataset.idx)], jid: sel.value || null }),
    });
    const data = await res.json();
    if (!data.ok) alert('Não salvou: ' + (data.error || 'erro'));
    await loadBdayAdmin();
  } catch {
    alert('Não consegui falar com o bot. Tenta de novo.');
  }
});

let eventsMe = null;

function fmtEventDate(d) {
  const p = d.split('-');
  return p[2] + '/' + p[1] + '/' + p[0];
}

async function loadEvents() {
  const res = await fetch('/api/events');
  const data = await res.json();
  eventsMe = data.me;
  document.getElementById('eventsSub').textContent = data.me
    ? 'Olá, ' + data.me.name + '! Marque se você vai ou não em cada evento.'
    : 'Próximos eventos do grupo · pra marcar presença, mande !painel no grupo e abra o link que o bot te enviar no privado.';
  const grid = document.getElementById('eventsGrid');
  if (data.events.length === 0) {
    grid.innerHTML = '<div class="member-empty">Nenhum evento futuro cadastrado.</div>';
    return;
  }
  grid.innerHTML = data.events.map((e, i) => {
    const extras = Object.keys(e.extra).map((k) => '<div class="menu-desc">' + escapeHtml(k) + ': ' + escapeHtml(e.extra[k]) + '</div>').join('');
    const names = (list) => list.length ? list.map((n) => '<div>' + escapeHtml(n) + '</div>').join('') : '—';
    const buttons = data.me
      ? '<div class="rsvp-row">' +
        '<button class="rsvp-btn' + (e.myStatus === 'going' ? ' on-going' : '') + '" data-idx="' + i + '" data-status="going">✅ Vou</button>' +
        '<button class="rsvp-btn' + (e.myStatus === 'not' ? ' on-not' : '') + '" data-idx="' + i + '" data-status="not">❌ Não vou</button>' +
        '</div>'
      : '';
    return '<div class="card"><div class="menu-title">📅 ' + escapeHtml(e.title) + '</div>' +
      '<div class="menu-desc">' + fmtEventDate(e.date) + ' · ' + escapeHtml(e.time || '') + '</div>' +
      '<div class="menu-desc">📍 ' + escapeHtml(e.location || '') + '</div>' + extras +
      '<div class="modal-section-label" style="margin-top:14px;">Confirmados (' + e.attendees.length + ')</div>' +
      '<div class="people-list">' + names(e.attendees) + '</div>' +
      '<div class="modal-section-label" style="margin-top:10px;">Ausentes (' + e.absentees.length + ')</div>' +
      '<div class="people-list">' + names(e.absentees) + '</div>' + buttons + '</div>';
  }).join('');
  grid.dataset.titles = JSON.stringify(data.events.map((e) => e.title));
}

document.getElementById('eventsGrid').addEventListener('click', async (e) => {
  const btn = e.target.closest('.rsvp-btn');
  if (!btn) return;
  const titles = JSON.parse(document.getElementById('eventsGrid').dataset.titles || '[]');
  try {
    const res = await fetch('/api/events/rsvp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'panel' },
      body: JSON.stringify({ title: titles[Number(btn.dataset.idx)], status: btn.dataset.status }),
    });
    const data = await res.json();
    if (!data.ok) { alert('Não deu: ' + (data.error || 'erro')); return; }
    await loadEvents();
  } catch {
    alert('Não consegui falar com o bot. Tenta de novo.');
  }
});

async function refreshRanking() {
  const { endpoint, emptyMsg } = RANKING_RANGES[rankingRange];
  const dateParam = document.getElementById('rankingDate').value || todayBR();
  const res = await fetch(endpoint + '?date=' + dateParam);
  const data = await res.json();

  document.getElementById('rankingSubtitle').textContent = 'Dia: ' + fmtDateBR(data.date) + ' · Total de mensagens: ' + data.total;

  const list = document.getElementById('rankingList');
  const topCount = data.ranking[0]?.mensagens || 1;
  list.innerHTML = data.ranking.length
    ? data.ranking
        .map(
          (r) =>
            '<div class="ranking-row">' +
            '<div class="ranking-pos">' + r.posicao + '</div>' +
            avatarImg(r.jid, r.nome, 'avatar-mini') +
            '<div style="flex:1; min-width:0;">' +
            '<div class="ranking-name">' + escapeHtml(r.nome) + '</div>' +
            '<div class="ranking-bar-track"><div class="ranking-bar-fill" style="width:' + Math.round((r.mensagens / topCount) * 100) + '%"></div></div>' +
            '</div>' +
            '<div style="text-align:right;">' +
            '<div class="ranking-count">' + r.mensagens + '</div>' +
            '<div style="font-size:11px; color:var(--text-secondary); font-weight:600;">' + r.percentual + '%</div>' +
            '</div>' +
            '</div>'
        )
        .join('')
    : '<div class="label" style="font-style:italic;">' + emptyMsg + '</div>';
}

document.querySelectorAll('#rankingToggle > .range-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#rankingToggle > .range-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    rankingRange = btn.dataset.range;
    refreshRanking();
  });
});

document.getElementById('rankingDate').value = todayBR();
document.getElementById('rankingDate').max = todayBR();
document.getElementById('rankingDate').addEventListener('change', (e) => {
  if (e.target.value) refreshRanking();
});

// 15s em vez de 5s — a VM tem CPU/RAM bem apertados, e atualizar a cada 5s
// so importa enquanto alguem esta de olho no painel. 15s ainda parece "ao
// vivo" pra esse uso (status do bot, ranking do dia), so com 1/3 das
// requisicoes.
const DASHBOARD_REFRESH_MS = 15000;
refresh();
refreshRanking();
setInterval(refresh, DASHBOARD_REFRESH_MS);
setInterval(refreshRanking, DASHBOARD_REFRESH_MS);
setInterval(() => refreshChart(document.getElementById('chartDate').value || todayBR()), DASHBOARD_REFRESH_MS);
</script>
</body>
</html>`;

// Pagina de login — mesmo estilo "Apple glass" do painel, so que com um
// cartao de vidro centralizado em vez do dashboard inteiro.
function renderLoginPage(hasError) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Entrar — Bothierry</title>
<style>
  :root {
    color-scheme: light;
    --bg-gradient:
      radial-gradient(1200px 700px at 12% -10%, rgba(0,122,255,.16), transparent 60%),
      radial-gradient(1000px 650px at 95% 0%, rgba(175,82,222,.14), transparent 55%),
      radial-gradient(900px 600px at 50% 100%, rgba(52,199,89,.12), transparent 60%),
      linear-gradient(180deg, #eef1f6 0%, #e9edf5 100%);
    --text-primary: rgba(0,0,0,.85);
    --text-secondary: rgba(60,60,67,.6);
    --glass-bg: rgba(255,255,255,.62);
    --glass-border: rgba(255,255,255,.6);
    --glass-shadow: 0 8px 32px rgba(31,41,55,.12), inset 0 1px 0 rgba(255,255,255,.7);
    --accent-blue: #007aff;
    --accent-red: #ff3b30;
    --accent-purple: #af52de;
    --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  }
  * { box-sizing: border-box; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
  @keyframes float-blob {
    0%, 100% { transform: translate(0,0) scale(1); }
    50% { transform: translate(24px,-18px) scale(1.06); }
  }
  @keyframes fade-up {
    from { opacity: 0; transform: translateY(14px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes shake {
    10%, 90% { transform: translateX(-1px); }
    20%, 80% { transform: translateX(2px); }
    30%, 50%, 70% { transform: translateX(-4px); }
    40%, 60% { transform: translateX(4px); }
  }
  .blob { position: fixed; border-radius: 50%; filter: blur(10px); pointer-events: none; z-index: 0; animation: float-blob 16s ease-in-out infinite; }
  .blob-1 { top: -120px; left: -100px; width: 420px; height: 420px; background: radial-gradient(circle at 30% 30%, rgba(0,122,255,.30), rgba(0,122,255,0) 70%); }
  .blob-2 { bottom: -160px; right: -140px; width: 480px; height: 480px; background: radial-gradient(circle at 60% 40%, rgba(175,82,222,.26), rgba(175,82,222,0) 70%); animation-direction: reverse; animation-duration: 20s; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, sans-serif;
    background: var(--bg-gradient);
    background-attachment: fixed;
    color: var(--text-primary);
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    -webkit-font-smoothing: antialiased;
    position: relative;
  }
  .login-card {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 360px;
    background: var(--glass-bg);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    backdrop-filter: blur(24px) saturate(180%);
    border: 1px solid var(--glass-border);
    box-shadow: var(--glass-shadow);
    border-radius: 22px;
    padding: 36px 32px;
    animation: fade-up .5s var(--ease-out);
    ${hasError ? 'animation: fade-up .5s var(--ease-out), shake .4s var(--ease-out) .5s;' : ''}
  }
  .login-logo {
    width: 56px; height: 56px; border-radius: 16px; object-fit: cover;
    display: block; margin: 0 auto 16px;
    box-shadow: 0 6px 18px rgba(0,0,0,.12);
  }
  .login-title { font-size: 20px; font-weight: 700; letter-spacing: -.01em; text-align: center; margin: 0 0 4px; }
  .login-sub { font-size: 13px; color: var(--text-secondary); text-align: center; margin: 0 0 28px; }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px; padding-left: 2px; }
  .field input {
    width: 100%;
    font-size: 15px;
    font-family: inherit;
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid rgba(60,60,67,.14);
    background: rgba(255,255,255,.7);
    color: var(--text-primary);
    outline: none;
    transition: border-color .15s var(--ease-out), box-shadow .15s var(--ease-out), background .15s var(--ease-out);
  }
  .field input:focus {
    border-color: var(--accent-blue);
    background: rgba(255,255,255,.95);
    box-shadow: 0 0 0 4px rgba(0,122,255,.14);
  }
  .error-msg {
    display: ${hasError ? 'flex' : 'none'};
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--accent-red);
    background: rgba(255,59,48,.1);
    border-radius: 10px;
    padding: 9px 12px;
    margin-bottom: 16px;
  }
  .submit-btn {
    width: 100%;
    font-size: 15px;
    font-weight: 700;
    font-family: inherit;
    color: #fff;
    background: linear-gradient(135deg, var(--accent-blue), var(--accent-purple));
    border: none;
    border-radius: 12px;
    padding: 13px;
    margin-top: 6px;
    cursor: pointer;
    box-shadow: 0 6px 16px rgba(0,122,255,.28);
    transition: transform .15s var(--ease-out), box-shadow .15s var(--ease-out), opacity .15s var(--ease-out);
  }
  .submit-btn:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(0,122,255,.34); }
  .submit-btn:active { transform: translateY(0); opacity: .9; }
  .login-footer { text-align: center; font-size: 11px; color: var(--text-secondary); margin-top: 22px; opacity: .7; }
</style>
</head>
<body>
  <div class="blob blob-1"></div>
  <div class="blob blob-2"></div>
  <div class="login-card">
    <img src="/bot-photo.png" alt="Bothierry" class="login-logo" onerror="this.style.display='none'" />
    <div class="login-title">Painel Bothierry</div>
    <div class="login-sub">Entre com suas credenciais para continuar</div>
    <div class="error-msg">⚠️ Usuário ou senha incorretos</div>
    <form method="POST" action="/login">
      <div class="field">
        <label for="user">Usuário</label>
        <input type="text" id="user" name="user" autocomplete="username" autofocus required />
      </div>
      <div class="field">
        <label for="pass">Senha</label>
        <input type="password" id="pass" name="pass" autocomplete="current-password" required />
      </div>
      <button type="submit" class="submit-btn">Entrar</button>
    </form>
    <div class="login-footer">Acesso restrito · Bothierry</div>
  </div>
</body>
</html>`;
}

// Links de acesso gerados pelo !painel: uso unico, valem 5 minutos e ficam so
// em memoria (reiniciar o bot invalida todos, o que e o desejado).
const LOGIN_TOKEN_TTL_MS = 5 * 60 * 1000;
const LOGIN_TOKEN_COOLDOWN_MS = 20 * 1000;
const loginTokens = new Map(); // token -> { jid, name, expires }
const lastTokenByJid = new Map(); // jid -> timestamp

// Escape de HTML no servidor (a pagina /entrar mostra o nome vindo do WhatsApp).
function escapeHtmlServer(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pruneLoginTokens() {
  const now = Date.now();
  for (const [token, entry] of loginTokens) if (entry.expires < now) loginTokens.delete(token);
  for (const [jid, ts] of lastTokenByJid) if (now - ts > LOGIN_TOKEN_COOLDOWN_MS) lastTokenByJid.delete(jid);
}

// Chamado pelo !painel. Retorna { token } ou { wait: segundos } se a pessoa
// pediu outro link cedo demais. Pedir um novo invalida o anterior da pessoa.
export function createLoginToken({ jid, name }) {
  pruneLoginTokens();
  const last = lastTokenByJid.get(jid);
  if (last && Date.now() - last < LOGIN_TOKEN_COOLDOWN_MS) {
    return { wait: Math.ceil((LOGIN_TOKEN_COOLDOWN_MS - (Date.now() - last)) / 1000) };
  }
  for (const [token, entry] of loginTokens) if (entry.jid === jid) loginTokens.delete(token);
  const token = crypto.randomBytes(24).toString('base64url');
  loginTokens.set(token, { jid, name, expires: Date.now() + LOGIN_TOKEN_TTL_MS });
  lastTokenByJid.set(jid, Date.now());
  return { token };
}

function peekLoginToken(token) {
  pruneLoginTokens();
  return typeof token === 'string' ? loginTokens.get(token) || null : null;
}

// Pagina simples (mesmo visual do login) usada pelo /entrar. O link do WhatsApp
// abre uma pagina com um botao — o token so e gasto no clique (POST), pra
// previa de link ou robo que apenas abra a URL nao queimar o acesso da pessoa.
function renderEntrarPage({ title, message, token }) {
  const form = token
    ? '<form method="POST" action="/entrar"><input type="hidden" name="t" value="' + token + '" /><button type="submit" class="submit-btn">Entrar no painel</button></form>'
    : '';
  const card =
    '<div class="login-card"><img src="/bot-photo.png" alt="Bothierry" class="login-logo" onerror="this.style.display=\'none\'" />' +
    '<div class="login-title">' + title + '</div><div class="login-sub">' + message + '</div>' + form +
    '<div class="login-footer">Acesso por link · Bothierry</div></div>';
  return renderLoginPage(false).replace(/<div class="login-card">[\s\S]*<\/div>\s*<\/body>/, () => card + '\n</body>');
}

// Acoes de administracao do painel (apagar audio, reiniciar, ver logs) — so
// aceitas via POST/GET com o cabecalho X-Requested-With (o fetch do proprio
// painel manda; um formulario/imagem de outro site nao consegue), alem do
// login por cookie que ja protege todas as rotas.
function isPanelRequest(req) {
  return req.headers['x-requested-with'] === 'panel';
}

function readJsonBody(req, callback) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 10_000) req.destroy();
  });
  req.on('end', () => {
    try {
      callback(null, body ? JSON.parse(body) : {});
    } catch (err) {
      callback(err);
    }
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// Ultimas linhas do log do PM2 (saida normal ou erros). Le so o final do
// arquivo (logs crescem muito numa VM pequena) e tira as linhas "[debug]",
// que trazem o texto das mensagens do grupo — nao faz sentido mostrar isso
// aqui, e polui o log.
const LOG_TAIL_BYTES = 256 * 1024;
async function readLogTail(kind, maxLines) {
  const pm2Home = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
  const file = path.join(pm2Home, 'logs', `Bothierry-${kind === 'error' ? 'error' : 'out'}.log`);
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer
      .toString('utf-8')
      .split('\n')
      .filter((line) => line && !line.includes('[debug]'))
      .slice(-maxLines);
  } finally {
    await handle.close();
  }
}

/**
 * Sobe um servidor HTTP local, bem simples, com um painel de monitoramento
 * (status de conexao, uptime, mensagens por hora, eventos recentes). So
 * modulo nativo 'http' — nenhuma dependencia nova no projeto.
 */
export function startDashboardServer(
  port,
  { getCommandsMenu = () => ({ categories: [], audios: [], birthdays: [] }), deleteAudio = () => ({ ok: false, error: 'indisponível' }) } = {},
) {
  const server = http.createServer((req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const urlObj = new URL(req.url, 'http://localhost');

    if (urlObj.pathname === '/login' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLoginPage(urlObj.searchParams.get('error') === '1'));
      return;
    }

    if (urlObj.pathname === '/login' && req.method === 'POST') {
      if (isRateLimited(ip)) {
        res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '300' });
        res.end('Muitas tentativas de login — tente novamente em alguns minutos.');
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 10_000) req.destroy(); // corpo absurdamente grande, corta
      });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const user = params.get('user') || '';
        const pass = params.get('pass') || '';
        const isAdminLogin = ADMIN_PASS !== '' && safeEqual(user, ADMIN_USER) && safeEqual(pass, ADMIN_PASS);
        const isViewerLogin = safeEqual(user, DASHBOARD_USER) && safeEqual(pass, DASHBOARD_PASS);
        if (isAdminLogin || isViewerLogin) {
          res.writeHead(302, {
            'Set-Cookie': `${SESSION_COOKIE_NAME}=${makeSessionCookieValue(isAdminLogin ? 'admin' : 'viewer')}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax`,
            Location: '/',
          });
          res.end();
        } else {
          recordFailedLogin(ip);
          res.writeHead(302, { Location: '/login?error=1' });
          res.end();
        }
      });
      return;
    }

    if (urlObj.pathname === '/entrar' && req.method === 'GET') {
      const entry = peekLoginToken(urlObj.searchParams.get('t'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        entry
          ? renderEntrarPage({ title: 'Olá, ' + escapeHtmlServer(entry.name ? formatDisplayName(entry.name) : 'amigo') + '!', message: 'Toque no botão pra entrar no painel e marcar presença nos eventos.', token: urlObj.searchParams.get('t') })
          : renderEntrarPage({ title: 'Link expirado', message: 'Esse link já foi usado ou venceu. Mande !painel no grupo pra receber outro.' }),
      );
      return;
    }

    if (urlObj.pathname === '/entrar' && req.method === 'POST') {
      if (isRateLimited(ip)) {
        res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '300' });
        res.end('Muitas tentativas — tente novamente em alguns minutos.');
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 10_000) req.destroy();
      });
      req.on('end', () => {
        const token = new URLSearchParams(body).get('t') || '';
        const entry = peekLoginToken(token);
        if (!entry) {
          recordFailedLogin(ip);
          res.writeHead(302, { Location: '/entrar?t=' });
          res.end();
          return;
        }
        loginTokens.delete(token); // uso unico
        console.log(`[painel] ${entry.name || entry.jid} entrou pelo link do !painel`);
        res.writeHead(302, {
          'Set-Cookie': `${SESSION_COOKIE_NAME}=${makeSessionCookieValue('member', { jid: entry.jid, name: entry.name })}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax`,
          Location: '/',
        });
        res.end();
      });
      return;
    }

    if (urlObj.pathname === '/logout') {
      res.writeHead(302, { 'Set-Cookie': `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`, Location: '/login' });
      res.end();
      return;
    }

    if (isRateLimited(ip)) {
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '300' });
      res.end('Muitas tentativas de login — tente novamente em alguns minutos.');
      return;
    }
    if (!isAuthorized(req)) {
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }

    if (req.url === '/api/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getDashboardData()));
    } else if (req.url.startsWith('/api/messages-per-hour')) {
      const url = new URL(req.url, 'http://localhost');
      const date = url.searchParams.get('date') || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      const groupJid = getMainGroupJid();
      const topSenderPerHour = groupJid ? getTopSenderPerHour(groupJid, date) : {};
      // Formata o nome de exibicao aqui (camada de apresentacao), sem mexer
      // no sender_name bruto guardado no historico.
      for (const hour of Object.keys(topSenderPerHour)) {
        const top = topSenderPerHour[hour];
        if (top) top.senderName = formatDisplayName(top.senderName);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ date, hours: getMessagesPerHourForDate(date), topSenderPerHour }));
    } else if (req.url.startsWith('/api/ranking-full')) {
      const url = new URL(req.url, 'http://localhost');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getTodayRanking(0, 24, url.searchParams.get('date'))));
    } else if (req.url.startsWith('/api/ranking')) {
      const url = new URL(req.url, 'http://localhost');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getTodayRanking(8, 18, url.searchParams.get('date'))));
    } else if (req.url.startsWith('/api/trend')) {
      const url = new URL(req.url, 'http://localhost');
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 14, 1), 90);
      const groupJid = getMainGroupJid();
      const trend = groupJid ? getMessageTrend(groupJid, days) : { dates: [], series: [] };
      trend.series = trend.series.map((s) => ({ ...s, name: formatDisplayName(s.name) }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(trend));
    } else if (req.url === '/api/me') {
      const session = getSession(req);
      sendJson(res, 200, { role: session?.role || 'viewer', name: session?.role === 'member' ? session.name : null });
    } else if (req.url === '/api/events') {
      const session = getSession(req);
      const me = session?.role === 'member' ? session : null;
      const today = getBrasiliaToday();
      const events = loadEvents()
        .filter((e) => e.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((e) => ({
          title: e.title,
          date: e.date,
          time: e.time,
          location: e.location,
          extra: e.extra || {},
          attendees: (e.attendees || []).map((a) => formatDisplayName(a.name)),
          absentees: (e.absentees || []).map((a) => formatDisplayName(a.name)),
          myStatus: me
            ? (e.attendees || []).some((a) => a.jid === me.jid) ? 'going'
              : (e.absentees || []).some((a) => a.jid === me.jid) ? 'not' : null
            : null,
        }));
      sendJson(res, 200, { me: me ? { name: formatDisplayName(me.name) } : null, events });
    } else if (req.url === '/api/events/rsvp' && req.method === 'POST') {
      const session = getSession(req);
      if (session?.role !== 'member') return sendJson(res, 403, { ok: false, error: 'entre pelo link do !painel pra marcar presença' });
      if (!isPanelRequest(req)) return sendJson(res, 403, { ok: false, error: 'requisição inválida' });
      readJsonBody(req, (err, data) => {
        if (err || typeof data.title !== 'string' || (data.status !== 'going' && data.status !== 'not')) {
          return sendJson(res, 400, { ok: false, error: 'pedido inválido' });
        }
        const person = { jid: session.jid, name: session.name };
        const updated = (data.status === 'going' ? addAttendee : addAbsentee)(data.title, person);
        if (!updated) return sendJson(res, 404, { ok: false, error: 'evento não encontrado' });
        console.log(`[painel] ${person.name} marcou ${data.status === 'going' ? 'presença' : 'ausência'} em "${data.title}"`);
        sendJson(res, 200, { ok: true });
      });
    } else if (req.url === '/api/audios/delete' && req.method === 'POST') {
      if (!isAdmin(req)) return sendJson(res, 403, { ok: false, error: 'só o administrador pode fazer isso' });
      if (!isPanelRequest(req)) return sendJson(res, 403, { ok: false, error: 'requisição inválida' });
      readJsonBody(req, (err, data) => {
        if (err || typeof data.name !== 'string') return sendJson(res, 400, { ok: false, error: 'pedido inválido' });
        const result = deleteAudio(data.name);
        console.log(`[painel] apagar áudio "${data.name}": ${result.ok ? 'ok' : result.error}`);
        sendJson(res, result.ok ? 200 : 400, result);
      });
    } else if (req.url === '/api/restart' && req.method === 'POST') {
      if (!isAdmin(req)) return sendJson(res, 403, { ok: false, error: 'só o administrador pode fazer isso' });
      if (!isPanelRequest(req)) return sendJson(res, 403, { ok: false, error: 'requisição inválida' });
      // So reinicia se estiver rodando sob o PM2 (que sobe o processo de novo);
      // fora dele, sair derrubaria o bot de vez.
      if (process.env.pm_id === undefined) return sendJson(res, 409, { ok: false, error: 'o bot não está rodando no PM2' });
      console.log('[painel] reinício do bot pedido pelo painel');
      sendJson(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 500);
    } else if (req.url.startsWith('/api/logs')) {
      if (!isAdmin(req)) return sendJson(res, 403, { lines: [], error: 'só o administrador pode ver os logs' });
      const url = new URL(req.url, 'http://localhost');
      const kind = url.searchParams.get('kind') === 'error' ? 'error' : 'out';
      const lines = Math.min(Math.max(Number(url.searchParams.get('lines')) || 100, 10), 300);
      readLogTail(kind, lines)
        .then((list) => sendJson(res, 200, { lines: list }))
        .catch((e) => sendJson(res, 500, { lines: [], error: e.code === 'ENOENT' ? 'arquivo de log não encontrado' : 'não consegui ler o log' }));
    } else if (req.url === '/api/admin/birthday-links' && req.method === 'GET') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: 'só o administrador pode ver isso' });
      const groupJid = getMainGroupJid();
      const members = groupJid ? getMemberList(groupJid) : [];
      const birthdays = [...loadBirthdays()]
        .sort((a, b) => a.month - b.month || a.day - b.day)
        .map((b) => {
          const match = resolveBirthdayMember(b, members);
          return { name: b.name, day: b.day, month: b.month, jid: match?.jid || null, source: match?.source || null };
        });
      sendJson(res, 200, {
        birthdays,
        members: members.map((m) => ({ jid: m.jid, name: formatDisplayName(m.name) })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
      });
    } else if (req.url === '/api/admin/birthday-links' && req.method === 'POST') {
      if (!isAdmin(req)) return sendJson(res, 403, { ok: false, error: 'só o administrador pode fazer isso' });
      if (!isPanelRequest(req)) return sendJson(res, 403, { ok: false, error: 'requisição inválida' });
      readJsonBody(req, (err, data) => {
        if (err || typeof data.name !== 'string' || (data.jid !== null && typeof data.jid !== 'string')) {
          return sendJson(res, 400, { ok: false, error: 'pedido inválido' });
        }
        const exists = loadBirthdays().some((b) => normalizeName(b.name) === normalizeName(data.name));
        if (!exists) return sendJson(res, 404, { ok: false, error: 'aniversariante não encontrado' });
        const groupJid = getMainGroupJid();
        const members = groupJid ? getMemberList(groupJid) : [];
        if (data.jid && !members.some((m) => m.jid === data.jid)) return sendJson(res, 400, { ok: false, error: 'membro não encontrado' });
        setBirthdayLink(data.name, data.jid || null);
        console.log(`[painel] ligação do aniversariante "${data.name}": ${data.jid || 'automático'}`);
        sendJson(res, 200, { ok: true });
      });
    } else if (req.url === '/api/commands') {
      const menu = getCommandsMenu();
      // Junta a cada aniversariante o membro ligado (foto + nome), pra conferir
      // na lista se a pessoa certa foi associada.
      const groupJid = getMainGroupJid();
      const members = groupJid ? getMemberList(groupJid) : [];
      menu.birthdays = (menu.birthdays || []).map((b) => {
        const match = resolveBirthdayMember(b, members);
        const member = match ? members.find((m) => m.jid === match.jid) : null;
        return { ...b, jid: match?.jid || null, member: member ? formatDisplayName(member.name) : null };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(menu));
    } else if (req.url === '/api/heatmap') {
      const groupJid = getMainGroupJid();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(groupJid ? getActivityHeatmap(groupJid) : { weekdayNames: [], matrix: [] }));
    } else if (req.url === '/api/members') {
      const groupJid = getMainGroupJid();
      const members = groupJid ? getMemberList(groupJid) : [];
      members.forEach((m) => { m.name = formatDisplayName(m.name); });
      // Ranking de hoje: mais mensagens primeiro; empates (inclusive os com 0, que
      // ficam por ultimo naturalmente) desempatam em ordem alfabetica.
      members.sort((a, b) => b.todayCount - a.todayCount || a.name.localeCompare(b.name, 'pt-BR'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(members));
    } else if (req.url.startsWith('/api/member')) {
      const url = new URL(req.url, 'http://localhost');
      const jid = url.searchParams.get('jid');
      const groupJid = getMainGroupJid();
      const stats = groupJid && jid ? getMemberStats(groupJid, jid) : null;
      if (!stats) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Membro nao encontrado' }));
      } else {
        stats.name = formatDisplayName(stats.name);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
      }
    } else if (req.url === '/api/system') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getSystemStats()));
    } else if (req.url.startsWith('/api/system-history')) {
      const url = new URL(req.url, 'http://localhost');
      const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 24, 1), 720);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getSystemStatsHistory(hours)));
    } else if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);
    } else if (req.url === '/bot-photo.png') {
      serveCachedImage(BOT_PHOTO_PATH, 'image/png', res);
    } else if (req.url.startsWith('/avatar')) {
      const url = new URL(req.url, 'http://localhost');
      const jid = url.searchParams.get('jid');
      const avatarPath = jid ? getAvatarPath(jid) : null;
      if (avatarPath) {
        serveCachedImage(avatarPath, 'image/jpeg', res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Nao encontrado');
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Nao encontrado');
    }
  });

  server.listen(port, () => {
    console.log(`📊 Painel de monitoramento em http://localhost:${port}`);
  });

  return server;
}
