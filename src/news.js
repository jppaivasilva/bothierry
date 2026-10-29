const G1_RSS_URL = 'https://g1.globo.com/rss/g1/';

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

/**
 * Busca as N manchetes mais recentes do feed do G1 — usado pra escolher a
 * noticia mais impactante do dia (foto do grupo) entre varias opcoes.
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
