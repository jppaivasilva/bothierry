import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'news_state.json');
const G1_RSS_URL = 'https://g1.globo.com/rss/g1/';

// Quantos links recentes guardar no historico de "ja enviado" — evita o arquivo
// crescer pra sempre; o feed do G1 gira bem mais rapido que isso.
const MAX_SENT_HISTORY = 200;

// Extrai o conteudo de uma tag XML simples (primeira ocorrencia), removendo CDATA se houver.
function extractXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!match) return null;
  const cdataMatch = match[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (cdataMatch ? cdataMatch[1] : match[1]).trim();
}

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

function loadSentLinks() {
  if (!fs.existsSync(STATE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')).sentLinks || [];
  } catch {
    return [];
  }
}

function saveSentLinks(links) {
  const trimmed = links.slice(-MAX_SENT_HISTORY);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ sentLinks: trimmed }));
}

/**
 * Busca o feed do G1 e retorna a primeira noticia do feed que ainda nao foi
 * enviada por !news (controlado por news_state.json, que sobrevive a reinicios
 * do bot). Retorna null se todas as noticias do feed atual ja foram enviadas.
 */
export async function getNextUnseenNews() {
  const res = await fetch(G1_RSS_URL);
  if (!res.ok) throw new Error(`status HTTP ${res.status}`);
  const xml = await res.text();

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const sentLinks = loadSentLinks();

  for (const item of items) {
    const link = decodeXmlEntities(extractXmlTag(item, 'link') || '');
    if (!link || sentLinks.includes(link)) continue;

    const title = decodeXmlEntities(extractXmlTag(item, 'title') || 'Sem título');
    const subtitle = extractXmlTag(item, 'atom:subtitle');

    saveSentLinks([...sentLinks, link]);
    return { title, subtitle: subtitle ? decodeXmlEntities(subtitle) : null, link };
  }

  return null;
}

/**
 * Busca as N manchetes mais recentes do feed do G1, sem passar pelo filtro de
 * "ja enviado" do !news (e sem marcar nada como enviado) — usado pra escolher
 * a noticia mais impactante do dia entre varias opcoes.
 */
export async function getRecentHeadlines(limit = 10) {
  const res = await fetch(G1_RSS_URL);
  if (!res.ok) throw new Error(`status HTTP ${res.status}`);
  const xml = await res.text();

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]).slice(0, limit);

  return items.map((item) => {
    const link = decodeXmlEntities(extractXmlTag(item, 'link') || '');
    const title = decodeXmlEntities(extractXmlTag(item, 'title') || 'Sem título');
    const subtitle = extractXmlTag(item, 'atom:subtitle');
    return { title, subtitle: subtitle ? decodeXmlEntities(subtitle) : null, link };
  });
}
