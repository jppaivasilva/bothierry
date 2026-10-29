#!/usr/bin/env bash
# Deploy automatico: roda no cron da VM (a cada 3 min). Se a branch main do
# GitHub tem commit novo, baixa, valida a sintaxe e reinicia o bot no PM2.
# Se a validacao falhar, volta pro commit anterior e NAO reinicia — o bot
# continua no ar com o codigo antigo. Detalhes e instalacao: README.md.
set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH" # o cron roda com PATH minimo
cd "$(dirname "$0")"

BRANCH="${DEPLOY_BRANCH:-main}"
PM2_APP="${PM2_APP:-Bothierry}"
FAILED_FILE=".deploy_failed_sha"
log() { echo "$(date '+%F %T') [deploy] $*"; }

git fetch -q origin "$BRANCH"
OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse "origin/$BRANCH")
[ "$OLD" = "$NEW" ] && exit 0

# Nao fica tentando de novo o mesmo commit que ja falhou na validacao.
if [ -f "$FAILED_FILE" ] && [ "$(cat "$FAILED_FILE")" = "$NEW" ]; then exit 0; fi

log "novo commit ${NEW:0:7} (atual ${OLD:0:7}), atualizando..."
git reset -q --hard "$NEW"

# Dependencias so se o package.json / package-lock.json mudaram.
if ! git diff --quiet "$OLD" "$NEW" -- package.json package-lock.json; then
  log "dependencias mudaram, rodando npm install..."
  # Se a instalacao falhar, volta pro commit anterior e NAO reinicia (senao o
  # codigo novo ficaria no disco sem as dependencias e o proximo ciclo nao
  # tentaria de novo, ja que o HEAD ja seria o novo).
  if ! npm install --omit=dev --no-audit --no-fund --silent 2>/tmp/bothierry-npm-error.txt; then
    log "ERRO no npm install — voltando pro commit ${OLD:0:7}, bot NAO reiniciado:"
    cat /tmp/bothierry-npm-error.txt
    git reset -q --hard "$OLD"
    echo "$NEW" > "$FAILED_FILE"
    exit 1
  fi
fi

# Valida a sintaxe de todos os arquivos antes de reiniciar.
for f in src/*.js scripts/*.js; do
  [ -f "$f" ] || continue
  if ! node --check "$f" 2>/tmp/bothierry-deploy-check.txt; then
    log "ERRO de sintaxe em $f — voltando pro commit ${OLD:0:7}, bot NAO reiniciado:"
    cat /tmp/bothierry-deploy-check.txt
    git reset -q --hard "$OLD"
    echo "$NEW" > "$FAILED_FILE"
    exit 1
  fi
done

rm -f "$FAILED_FILE"
pm2 restart "$PM2_APP" --update-env >/dev/null
log "ok, ${NEW:0:7} no ar."
