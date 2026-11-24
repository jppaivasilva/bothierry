import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed } from '../src/gameNews.js';

const XML = `<rss><channel>
<item><title>GTA 6 ganha trailer</title><link>https://br.ign.com/gta/1/x</link>
<description>&lt;img src="https://sm.ign.com/a.jpg" /&gt;Texto da materia</description><pubDate>Tue, 24 Nov 2026 14:46:47 +0000</pubDate></item>
<item><title><![CDATA[Outra noticia]]></title><link><![CDATA[https://canaltech.com.br/games/2/]]></link>
<description><![CDATA[<p>Sem imagem</p>]]></description><pubDate>Mon, 23 Nov 2026 10:00:00 -0300</pubDate>
<enclosure url="https://t.ctcdn.com.br/img.png" type="image/png" length="0"/></item>
<item><title></title><link>https://x.com/sem-titulo</link></item>
</channel></rss>`;

test('feed RSS: titulo, link, data, resumo e imagem (inline ou enclosure); item sem titulo some', () => {
  const items = parseFeed(XML, { name: 'Fonte' });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'GTA 6 ganha trailer');
  assert.equal(items[0].imageUrl, 'https://sm.ign.com/a.jpg');
  assert.equal(items[0].summary, 'Texto da materia');
  assert.equal(items[1].imageUrl, 'https://t.ctcdn.com.br/img.png');
  assert.equal(items[1].link, 'https://canaltech.com.br/games/2/');
  assert.ok(items[0].date > 0);
});
