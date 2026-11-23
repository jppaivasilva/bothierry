// Historico de versoes (aba "Versoes" do painel, so admin): os PRs mergeados,
// lidos do git da propria VM, com o texto em portugues vindo de changelog.json
// (uma entrada por PR — adicione a do PR novo no mesmo PR). O PR mais recente
// alcancavel a partir do HEAD e a versao que esta no ar.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_MS = 30 * 1000;
let cache = { at: 0, value: null };

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function loadChangelog() {
  try {
    return new Map(JSON.parse(fs.readFileSync(path.join(ROOT, 'changelog.json'), 'utf-8')).map((e) => [e.pr, e]));
  } catch {
    return new Map();
  }
}

// https://github.com/owner/repo(.git) ou git@github.com:owner/repo(.git) -> https://github.com/owner/repo
function repoUrl() {
  try {
    const m = git('remote', 'get-url', 'origin').match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    return m ? `https://github.com/${m[1]}` : null;
  } catch {
    return null;
  }
}

/** { repoUrl, items: [{ pr, titulo, resumo, date (ISO), hash, link, live }] } — mais novo primeiro. */
export function getVersionHistory() {
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  const changelog = loadChangelog();
  const url = repoUrl();
  let items = [];
  try {
    const log = git('log', '--merges', '--first-parent', '--format=%h%x1f%aI%x1f%s%x1f%b%x1e');
    items = log
      .split('\x1e')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((record) => {
        const [hash, date, subject, body] = record.split('\x1f');
        const pr = Number((subject.match(/pull request #(\d+)/) || [])[1]);
        if (!pr) return null;
        const entry = changelog.get(pr);
        return {
          pr,
          titulo: entry?.titulo || (body || subject).split('\n')[0],
          resumo: entry?.resumo || null,
          date,
          hash,
          link: url ? `${url}/pull/${pr}` : null,
          live: false,
        };
      })
      .filter(Boolean);
    if (items[0]) items[0].live = true;
  } catch {
    // sem git na maquina: mostra so o que ha no changelog, sem datas
    items = [...changelog.values()].sort((a, b) => b.pr - a.pr).map((e) => ({ pr: e.pr, titulo: e.titulo, resumo: e.resumo, date: null, hash: null, link: url ? `${url}/pull/${e.pr}` : null, live: false }));
  }
  cache = { at: Date.now(), value: { repoUrl: url, items } };
  return cache.value;
}
