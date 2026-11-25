// Noticias no grupo (comecando por GAMES): le feeds RSS em portugues, a IA
// escolhe o que combina com os interesses do grupo, e o bot manda o link COM
// a miniatura (previa) da materia. Estrutura por assunto (TOPICS) pra entrar
// outros depois (tecnologia, filmes e series...).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractXmlTag, decodeXmlEntities } from './news.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'news_sent.json');

export const TOPICS = [
  {
    key: 'games',
    label: 'GAMES/JOGOS',
    weight: 'ALTISSIMA relevancia',
    emoji: '🎮',
    sources: [
      { name: 'IGN Brasil', url: 'https://br.ign.com/feed.xml' },
      { name: 'Canaltech Games', url: 'https://canaltech.com.br/rss/games/' },
    ],
  },
];

const MAX_AGE_HOURS = 36; // so noticias recentes
const KEEP_SENT_DAYS = 30;
const USER_AGENT = 'Mozilla/5.0 (compatible; BothierryBot/1.0)';

const stripHtml = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** Itens de um feed RSS: [{ title, link, date (ms), summary, imageUrl }] — funcao pura, testavel com um XML. */
export function parseFeed(xml, source) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map((m) => m[1])
    .map((item) => {
      const link = decodeXmlEntities(extractXmlTag(item, 'link') || '').trim();
      const title = decodeXmlEntities(extractXmlTag(item, 'title') || '').trim();
      const descHtml = decodeXmlEntities(extractXmlTag(item, 'description') || '');
      const enclosure = (item.match(/<enclosure[^>]+url="([^"]+)"[^>]*>/i) || [])[1];
      const media = (item.match(/<media:content[^>]+url="([^"]+)"/i) || [])[1];
      const inline = (descHtml.match(/<img[^>]+src="([^"]+)"/i) || [])[1];
      const imageUrl = [enclosure, media, inline].map((u) => (u ? decodeXmlEntities(u) : null)).find((u) => u && /^https?:\/\//.test(u) && !/\.(mp3|mp4)(\?|$)/i.test(u)) || null;
      const date = Date.parse(extractXmlTag(item, 'pubDate') || '') || 0;
      return { title, link, date, summary: stripHtml(descHtml).slice(0, 220), imageUrl, source: source.name };
    })
    .filter((i) => i.title && /^https?:\/\//.test(i.link));
}

async function fetchText(url, timeoutMs = 15000) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`status HTTP ${res.status}`);
  return res.text();
}

// ---- estado: o que ja foi mandado (pra nao repetir) ----
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) || { sent: [] };
  } catch {
    return { sent: [] };
  }
}

function saveSent(item) {
  const state = loadState();
  const cutoff = Date.now() - KEEP_SENT_DAYS * 86400000;
  state.sent = [...state.sent.filter((s) => s.at > cutoff), { link: item.link, title: item.title, at: Date.now() }];
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}

const words = (title) => new Set(title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 3));
// Mesma materia em duas fontes: titulos com muitas palavras em comum.
function similarTitle(a, b) {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common += 1;
  return common / Math.min(wa.size, wb.size) >= 0.6;
}

/** Candidatas: recentes, ainda nao mandadas e sem repetir a mesma materia entre as fontes. */
export async function getCandidates(topic, { feeds = null } = {}) {
  const state = loadState();
  const sentLinks = new Set(state.sent.map((s) => s.link));
  const sentTitles = state.sent.map((s) => s.title);
  const minDate = Date.now() - MAX_AGE_HOURS * 3600000;
  const diagnostics = [];
  const all = [];
  for (const source of topic.sources) {
    try {
      const xml = feeds ? feeds[source.name] : await fetchText(source.url);
      const items = parseFeed(xml, source);
      diagnostics.push({ source: source.name, ok: true, items: items.length });
      all.push(...items);
    } catch (err) {
      diagnostics.push({ source: source.name, ok: false, error: String(err.message || err) });
    }
  }
  const picked = [];
  for (const item of all.filter((i) => i.date >= minDate && !sentLinks.has(i.link)).sort((a, b) => b.date - a.date)) {
    if (sentTitles.some((t) => similarTitle(t, item.title)) || picked.some((p) => similarTitle(p.title, item.title))) continue;
    picked.push(item);
  }
  return { candidates: picked.slice(0, 25), diagnostics };
}

// ---- miniatura (a "thumb" da previa do link) ----
/** Reduz uma imagem pra miniatura JPEG pequena (a previa do WhatsApp so precisa disso). */
export async function makeThumbnail(buffer) {
  const sharp = (await import('sharp')).default;
  return sharp(buffer).resize({ width: 320, height: 180, fit: 'cover' }).jpeg({ quality: 65 }).toBuffer();
}

async function downloadImage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(12000), redirect: 'follow' });
  if (!res.ok) throw new Error(`imagem: status HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) throw new Error('imagem vazia ou grande demais');
  return buffer;
}

// Sem imagem no feed: tenta a og:image da propria pagina da materia.
async function findOgImage(link) {
  const html = await fetchText(link, 12000);
  const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return m ? decodeXmlEntities(m[1]) : null;
}

/** Miniatura da materia (Buffer JPEG) ou null se nao achou/baixou imagem. */
export async function getThumbnail(item) {
  try {
    const url = item.imageUrl || (await findOgImage(item.link));
    if (!url) return null;
    return await makeThumbnail(await downloadImage(url));
  } catch {
    return null;
  }
}

// ---- escolha pela IA ----
/** Pede pra IA ranquear ate 3 candidatas. Retorna [{ item, resumo }] em ordem de preferencia (sem IA: as mais novas). */
export async function rankCandidates(client, topic, candidates) {
  if (candidates.length === 0) return [];
  const fallback = () => candidates.slice(0, 3).map((item) => ({ item, resumo: null }));
  if (!client) return fallback();
  const list = candidates.map((c, i) => `${i + 1}. [${c.source}] ${c.title}${c.summary ? ` — ${c.summary.slice(0, 140)}` : ''}`).join('\n');
  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            `Voce escolhe noticias pra um grupo de amigos brasileiros no WhatsApp. Assunto: ${topic.label} (${topic.weight}). ` +
            'Prefira o que os fas de games querem saber: grandes lancamentos e datas, GTA, grandes estudios e franquias, ' +
            'novidades de consoles/PC, polemicas relevantes, trailers e anuncios. Evite guias de como fazer, promocoes e ofertas, ' +
            'listas genericas, podcasts e materias fracas ou repetitivas. ' +
            'Responda em JSON: {"ordem":[ate 3 numeros das melhores, da melhor pra pior],"resumo":"uma frase curta e animada em portugues (ate 120 caracteres) sobre a MELHOR, sem repetir o titulo"}.',
        },
        { role: 'user', content: list },
      ],
      max_tokens: 200,
    });
    const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');
    const order = (parsed.ordem || []).map((n) => candidates[Number(n) - 1]).filter(Boolean);
    if (order.length === 0) return fallback();
    return order.slice(0, 3).map((item, i) => ({ item, resumo: i === 0 ? parsed.resumo || null : null }));
  } catch {
    return fallback();
  }
}

/**
 * Manda UMA noticia do assunto: a melhor candidata que tenha miniatura. Marca como enviada.
 * Retorna { sent: boolean, item?, diagnostics, reason? }.
 */
export async function sendTopicNews(sock, groupJid, client, topic, { onSent } = {}) {
  const { candidates, diagnostics } = await getCandidates(topic);
  if (candidates.length === 0) return { sent: false, diagnostics, reason: 'sem noticias novas (ou nenhum feed respondeu)' };

  const ranked = await rankCandidates(client, topic, candidates);
  for (const { item, resumo } of ranked) {
    const thumb = await getThumbnail(item);
    if (!thumb) continue; // a noticia precisa ter a thumb: tenta a proxima
    const text = [`${topic.emoji} *${item.title}*`, resumo, item.link].filter(Boolean).join('\n');
    const sentMsg = await sock.sendMessage(groupJid, {
      text,
      linkPreview: { 'canonical-url': item.link, 'matched-text': item.link, title: item.title, description: item.summary || undefined, jpegThumbnail: thumb },
    });
    saveSent(item);
    if (onSent) onSent(sentMsg);
    return { sent: true, item, diagnostics };
  }
  return { sent: false, diagnostics, reason: 'nenhuma das melhores candidatas tinha imagem pra miniatura' };
}

/** As noticias mais recentes de games (sem filtrar o que ja foi mandado) — usado pelas respostas do bot. */
export async function getRecentGameNews(limit = 5) {
  const topic = TOPICS[0];
  const all = [];
  for (const source of topic.sources) {
    try {
      all.push(...parseFeed(await fetchText(source.url), source));
    } catch {
      // fonte fora do ar: segue com as outras
    }
  }
  const picked = [];
  for (const item of all.sort((a, b) => b.date - a.date)) {
    if (picked.some((p) => similarTitle(p.title, item.title))) continue;
    picked.push(item);
    if (picked.length >= limit) break;
  }
  return picked;
}
