# Bothierry — bot de WhatsApp do grupo

Bot que conecta no WhatsApp (via [Baileys](https://github.com/WhiskeySockets/Baileys)), escuta as mensagens do grupo e grava localmente quem enviou o quê e quando. Com isso dá pra saber quantas mensagens cada pessoa mandou por dia, gerar um resumo da conversa, ver um painel de monitoramento com gráficos, e muito mais.

Não usa a API oficial da Meta — conecta como se fosse o "WhatsApp Web" de um número próprio, então não precisa de aprovação nem custa nada. Em troca, o número que roda o bot precisa continuar logado (igual o WhatsApp Web normal).

O armazenamento é um arquivo de texto simples (`messages.jsonl`, uma linha JSON por mensagem) em vez de um banco de dados — de propósito, pra não depender de nenhum pacote com código nativo.

---

## 1. Onde o bot roda hoje: VM na Oracle Cloud

Desde outubro/2026 o bot não roda mais no PC local — foi migrado pra uma **máquina virtual gratuita na Oracle Cloud** (tier "Always Free"), pra ficar disponível 24h sem depender do computador de ninguém estar ligado.

**Acesso:**
- **IP público:** `163.176.180.33`
- **SSH:** `ssh -i <caminho-da-chave> ubuntu@163.176.180.33` (a chave privada `.pem`/`.key` foi gerada na criação da instância — guarde em local seguro, sem ela não dá pra acessar a VM)
- **Pasta do projeto na VM:** `/home/ubuntu/bothierry`

**Especificações da VM:**
- Shape: `VM.Standard.E2.1.Micro` (AMD, sempre grátis) — 2 vCPUs, ~1GB RAM, 45GB de disco
- SO: Ubuntu 24.04 LTS
- Swap de 2GB configurado (`/swapfile`) como rede de segurança pra memória
- Node.js v24 (via NodeSource), PM2 pra gerenciar o processo

**Comandos úteis na VM (depois de `ssh` conectar):**
```bash
cd ~/bothierry
pm2 list                        # ver se o bot está rodando
pm2 logs Bothierry --lines 50   # ver os últimos logs
pm2 restart Bothierry           # reiniciar (precisa depois de qualquer mudança de código)
```

**Como aplicar uma mudança de código (deploy automático):** a VM verifica o GitHub a cada 3 minutos (cron rodando `deploy.sh`). Quando a branch `main` tem commit novo, ela baixa, valida a sintaxe de todos os `.js` e reinicia o bot no PM2. Se a validação falhar, volta pro commit anterior e **não** reinicia — o bot continua no ar com o código antigo. Ou seja: depois do merge na `main`, é só esperar uns minutos.

Acompanhar / forçar:
```bash
tail -20 ~/bothierry/deploy.log      # histórico dos deploys (e erros)
~/bothierry/deploy.sh                # roda na hora, sem esperar o cron
```

Instalação (uma vez só, na VM) — baixa o repositório por cima da pasta atual (os arquivos locais de dados, `.env`, `audios/`, `auth_info/` etc. não são tocados, estão no `.gitignore`), guarda um backup do `src/` e agenda o cron:
```bash
cd ~/bothierry && cp -r src ~/src-backup-$(date +%F) \
  && git init -q -b main && git remote add origin https://github.com/jppaivasilva/bothierry.git \
  && git fetch -q origin main && git reset -q --hard origin/main && chmod +x deploy.sh \
  && (crontab -l 2>/dev/null | grep -v deploy.sh; echo '*/3 * * * * flock -n /tmp/bothierry-deploy.lock /home/ubuntu/bothierry/deploy.sh >> /home/ubuntu/bothierry/deploy.log 2>&1') | crontab - \
  && pm2 restart Bothierry
```
O repositório é público, então a VM baixa sem senha nem chave. Se um dia ele ficar privado, será preciso uma chave de deploy (Deploy key) no GitHub.

Deploy manual (plano B, se o automático estiver quebrado): copiar o arquivo com `scp` e reiniciar:
```bash
scp -i <chave> src/index.js ubuntu@163.176.180.33:/home/ubuntu/bothierry/src/index.js
ssh -i <chave> ubuntu@163.176.180.33 "cd ~/bothierry && node --check src/index.js && pm2 restart Bothierry"
```

**Autostart:** o PM2 está configurado (`pm2 startup` + `pm2 save`) pra subir o bot sozinho se a VM reiniciar.

**Firewall:** por padrão só a porta 22 (SSH) é liberada. A porta 4321 (painel de monitoramento, veja seção 9) foi liberada manualmente em duas camadas — iptables da própria VM e Security List da Oracle (Networking → Virtual Cloud Networks → Security Lists → Add Ingress Rules).

### 1.1. Rodando localmente (alternativa, não é mais o setup atual)

Ainda é possível rodar o bot num PC comum, se um dia for necessário migrar de volta:

```bash
npm install
npm start
```

Um QR code aparece no terminal — escaneie em **WhatsApp → Aparelhos conectados → Conectar um aparelho**. A sessão fica salva em `auth_info/`.

Pra deixar rodando continuamente: `pm2 start ecosystem.config.cjs && pm2 save` (mesmo `ecosystem.config.cjs` funciona em Windows ou Linux, sem mudança).

---

## 2. Ver a contagem de mensagens

**Opção A — direto no grupo:** `!ranking` (ou `/ranking`) mostra o placar do dia. `!menu` (ou `/menu`) lista todos os comandos disponíveis.

**Opção B — pelo painel web:** veja a seção 9.

**Opção C — pelo terminal (rodando na VM ou localmente):**
```bash
npm run report
npm run report 2026-10-27   # data específica
```

---

## 3. Aniversariantes

**Cadastrar/editar:** edite `birthdays.json` na raiz do projeto:
```json
[
  { "name": "Maria", "day": 15, "month": 9 },
  { "name": "João", "day": 2, "month": 12, "groupJid": "1203...@g.us" }
]
```
- `groupJid` é opcional: se informado, o aviso vai só pro grupo especificado; se omitido, vai pra todos os grupos que o número participa.

**Ver a lista:** `!aniversariantes` (ou `/aniversariantes`).

**Aviso:** todo dia às 9h (horário de Brasília). Junto, o bot **renomeia o grupo** pra `🎉 Parabéns, Nome! 🎂` (precisa ser admin — veja seção 5) e reverte pro nome padrão (hoje `FISCAIS™️`) à meia-noite seguinte, mesmo em sequências de aniversários em dias seguidos. Mais de uma pessoa no mesmo dia: o nome junta todo mundo (`🎉 Parabéns, Lucas e Vini! 🎂`).

---

## 4. Resumo da conversa com IA (`!resumo`)

Manda pra OpenAI o texto de todas as mensagens de hoje e responde com um resumo em tópicos.

**Configurar:** copie `.env.example` pra `.env` e preencha:
```
OPENAI_API_KEY=sua-chave-aqui
```
Reinicie o bot depois. Sem a chave, `!resumo` avisa que falta configurar, em vez de quebrar.

O texto de cada mensagem é gravado em `messages.jsonl` — é isso que o `!resumo` lê.

---

## 5. Comandos de mídia e grupo

- **`!transcrever`** (respondendo um áudio): transcreve usando Whisper da OpenAI (mesma chave da seção 4).
- **`!figurinha`** (respondendo uma foto): converte em figurinha WebP 512x512, local (usa `sharp`, sem IA).
- **`!renomear Novo Nome`**: renomeia o grupo.
- **`!fotogrupo`** (respondendo uma foto): troca a foto do grupo.
- **`!fotobot`** (respondendo uma foto): troca a foto de perfil do próprio bot.

Todos os três últimos exigem o bot ser **admin do grupo** pra funcionar (exigência do WhatsApp).

**Fotos temáticas automáticas do bot:** troca sozinho a foto de perfil em datas comemorativas (Natal, Ano Novo, Halloween, Carnaval, Páscoa, Festa Junina), usando imagens da pasta `avatarbot/`. Checagem às 03h30 e ao conectar; só troca se o tema mudou (`avatar_state.json`).

---

## 6. Eventos

- **`!eventos`**: lista eventos futuros, com quem confirmou/não confirmou presença.
- **`!addevento`**: cadastra um evento novo (manda `!addevento` sozinho pra ver o formato).
- **`!vou` / `!naovou`**: confirma/marca ausência. Aceita `!vou <parte do nome>` quando há mais de um evento.

Dados em `events.json`.

---

## 7. Mensagens automáticas diárias

- **08h:** bom dia + dia da semana (ou aviso de feriado nacional) + **previsão do tempo** (Santos, São Vicente, Cubatão, Praia Grande, São Paulo Capital — via Open-Meteo, grátis).
- **18h:** ranking do expediente (08h-18h) do dia.

Só em dias úteis (seg-sex), consultando feriados nacionais via BrasilAPI. Horários configuráveis em `MORNING_HOUR`/`EVENING_HOUR` no `src/index.js`.

**Ranking semanal:** toda sexta às 18:05, soma o expediente de segunda a sexta.

**Aviso de marco (50/100 mensagens):** dispara sozinho quando alguém bate exatamente 50 ou 100 mensagens no dia.

---

## 8. Detectores automáticos (sem comando)

- **Link repetido:** se um link já foi mandado no grupo nas últimas 24h, o bot zoa + manda áudio.
- **Link sem preview:** se o link não gerou prévia visível no WhatsApp (seja porque `extendedTextMessage` veio sem `jpegThumbnail`, seja porque o remetente nem chegou a gerar `extendedTextMessage`), o bot responde "sem thumb amigo? 👀" citando a mensagem. Não dispara em respostas citadas (replies também geram `extendedTextMessage` sem thumbnail, mas não são links sem prévia).
- **Regras do grupo** (`regras/*.txt`): fiscaliza frases-gatilho cadastradas e intervém sozinho. `!regras` lista todas.
- **iPhone (Regra 93):** além das frases fixas, usa IA pra julgar o tom quando "iPhone" aparece sem bater nenhum gatilho literal.
- **Insulto ao bot:** se alguém xingar o bot (mencionando @Bothierry), a IA classifica — 1º/2º aviso, 3º insulto = **remoção do grupo** (ação real e irreversível pelo bot).

---

## 9. Painel de monitoramento (web)

O bot sobe um painel web, acessível de qualquer lugar (não só da própria VM):
- **`https://painel.bothierry.com.br`** — link permanente com HTTPS, via Cloudflare Tunnel (domínio `bothierry.com.br`, registrado na GoDaddy e com DNS apontado pra Cloudflare). Esse é o link que aparece nas mensagens do bot (marcos de mensagens, resumo do dia, `!ranking`).
- `http://163.176.180.33:4321` — acesso direto por IP (sem HTTPS), mantido como alternativa.

**Login:** tela própria de login (cookie de sessão assinado, 30 dias), estilo "Apple glass" igual ao resto do painel — não é mais o prompt feio do navegador (HTTP Basic Auth).
- Usuário: `comichosas`
- Senha: `comichosas`

(Configurado via `DASHBOARD_USER`/`DASHBOARD_PASS` no `.env` da VM — troque se quiser mais segurança, hoje é uma senha simples combinada entre vocês.)

O tunnel do Cloudflare roda como **serviço systemd** na VM (`sudo systemctl status cloudflared`), configurado em `/etc/cloudflared/config.yml`, separado do processo do bot no PM2.

Visual em estilo "Apple" (tipografia SF Pro, cores do sistema iOS/macOS, cards com leve glassmorphism). Tem **4 abas**:

### Visão geral
- Gráfico **"Mensagens por Hora"** do dia selecionado — acima de cada barra com mensagem, mostra 👑 + foto + nome de quem mais mandou mensagem naquela hora (fileira alinhada com a posição real de cada barra, calculada pelo Chart.js). Em telas estreitas (celular), o gráfico vira horizontalmente rolável em vez de espremer as 24 barras.
- Card **Ranking** do dia (mensagens + percentual de cada pessoa), com toggle "Expediente (08h-18h)" / "Dia completo" e seletor de data pra ver qualquer dia.

### Atividade
- **Tendência de mensagens por pessoa** — gráfico de linha dos últimos 7/14/30 dias, top participantes.
- **Mapa de calor** — mensagens por dia da semana × hora, olhando todo o histórico do grupo.

### Sistema
- Cards de status: online/offline, uptime 24h, quedas 24h, mensagens na última hora, memória do processo (RSS).
- Eventos de conexão recentes, erros recentes, comandos mais usados, última execução de cada cron.

### Servidor
- Uso de **CPU, memória e armazenamento da própria VM** (não do processo do bot — da máquina inteira), com gráfico de histórico (6h/24h/7 dias).
- Dados gravados a cada 5 minutos em `metrics.jsonl` (cron próprio), 30 dias de retenção.

**Fotos de perfil no painel:** o bot tenta buscar a foto de perfil de cada pessoa via WhatsApp (`sock.profilePictureUrl`) e guarda em cache na pasta `avatars/` (sincroniza ao conectar e todo dia às 03h30). Quando a pessoa tem a privacidade da foto restrita, o WhatsApp recusa (`not-authorized`) e o painel mostra as iniciais num círculo colorido como alternativa — **não tem como contornar isso, é a configuração de privacidade de cada um**.

**Associar foto manualmente** (quando o WhatsApp não consegue buscar): peça pra alguém mandar a foto da pessoa, aí rode na VM:
```bash
node scripts/set-avatar.js "Nome Da Pessoa" caminho/da/foto.jpg
```
O script acha o JID certo pelo nome (aceita apelido cadastrado em `apelidos.txt` também) e salva em `avatars/`. Fotos associadas manualmente nunca são sobrescritas pela sincronização automática.

**Nomes padronizados:** `src/displayNames.js` tem um mapa de correção (acentos, maiúsculas/minúsculas, desambiguação de homônimos — ex: há dois "Gabriel" no grupo, um deles aparece como "Gabriel (Gabs)") aplicado só na exibição, nunca no dado bruto gravado.

---

## 10. Perguntar dados do grupo (mencionando o bot)

Mencione **@Bothierry** com uma pergunta sobre estatísticas:
> @Bothierry quantas vezes o Fulano ficou no top 3 das 08 às 18h?
>
> @Bothierry quais mensagens o Fulano mandou hoje?

A IA só escolhe entre consultas reais nos dados (nunca inventa). Precisa de `OPENAI_API_KEY`.

**Apelidos:** cadastre em `apelidos.txt` (`Nome Completo;apelido1;apelido2`) pra perguntas tipo "quem é o Burro?" funcionarem.

---

## 11. Outros comandos

- **`!meme <nome>`**: template de meme popular (API do Imgflip, sem legenda).
- **`!audios`**: lista áudios tocáveis — qualquer arquivo em `audios/` vira comando `!nome-do-arquivo` automaticamente.
- **`!salvaraudio nome`**: responda a um áudio do grupo com isso pra salvar ele em `audios/` com o nome escolhido; depois qualquer um chama com `!nome`. Não sobrescreve comandos nem áudios existentes.
- **`!schedule`**: lista mensagens agendadas pendentes (editar `scheduled_messages.json`).
- **`!policiafederal`**: nota de esclarecimento de zoeira.
- **`!otario`** (respondendo alguém): marca a pessoa.
- **`!regulamento`** / **`!megasena`**: textos fixos (`regulamento.txt`/`megasena.txt`).

---

## 12. Apuração das Eleições 2026 — concluído

O bot acompanhou os dois turnos da eleição presidencial:
- **1º turno** (04/10/2026): apuração parcial a cada 10 min.
- **2º turno** (25/10/2026, entre Flávio Bolsonaro e Lula): apuração a partir das 17h (quando as urnas fecham), incluindo **percentual de urnas apuradas por região** (Norte/Nordeste/Centro-Oeste/Sudeste/Sul, agregado pelos 27 estados).

**Quando a apuração fechou em 100%:** o bot mandou uma mensagem anunciando o vencedor, renomeou o grupo pra `DEU LULA` ou `DEU FLAVIO`, e trocou a foto do bot pra um tema do presidente eleito (terno azul pra Flávio, camisa vermelha pra Lula). O nome do grupo voltou sozinho pro padrão (`FISCAIS™️`) na meia-noite seguinte.

Essa feature já cumpriu o papel (eleição terminada) — o código (`src/elections.js`, bloco de eleições no `src/index.js`) continua no projeto, mas não é mais necessário removê-lo às pressas.

---

## 13. Arquivamento de mensagens antigas

`messages.jsonl` mantém só os últimos 30 dias "quentes". Mensagens mais antigas vão pra `archive/messages-YYYY-MM.jsonl` (um arquivo por mês), automaticamente, ao iniciar o bot e todo dia às 3h. `npm run report` consegue consultar qualquer data, mesmo arquivada.

---

## 14. Estrutura do projeto

```
bothierry/
├── src/
│   ├── index.js          # bot principal: conecta, escuta mensagens, comandos, crons
│   ├── db.js              # grava/consulta mensagens, arquiva antigas, ranking/trend/heatmap
│   ├── metrics.js         # métricas do painel: conexão, comandos, crons, uso de CPU/memória/disco
│   ├── dashboard.js       # servidor HTTP + HTML/CSS/JS do painel de monitoramento
│   ├── avatars.js         # cache de fotos de perfil (sock.profilePictureUrl)
│   ├── displayNames.js    # normalização de nomes de exibição (acento, maiuscula, desambiguação)
│   ├── elections.js       # integração com dados oficiais do TSE
│   ├── groupPhoto.js      # edição de foto do bot via IA (notícia do dia, tema do eleito)
│   ├── weather.js         # previsão do tempo (Open-Meteo) pra mensagem de bom dia
│   ├── dataQuestions.js   # perguntas sobre dados do grupo via @Bothierry + IA
│   ├── birthdays.js       # aniversariantes
│   └── report.js          # relatório via terminal
├── scripts/
│   └── set-avatar.js      # associa foto manualmente a alguém (quando o WhatsApp recusa)
├── ecosystem.config.cjs   # config do PM2 (funciona igual em Windows ou Linux)
├── package.json
├── .env                   # OPENAI_API_KEY, DASHBOARD_USER, DASHBOARD_PASS (não versionado)
├── audios/                # áudios tocáveis, link repetido, envios agendados
├── regras/                # regras do grupo (.txt)
├── avatars/                # cache de fotos de perfil (gerado automaticamente)
├── avatarbot/              # fotos temáticas do próprio bot
├── assets/                 # foto-base do bot, imagens de comandos fixos
├── messages.jsonl          # mensagens dos últimos 30 dias
├── archive/                # mensagens mais antigas, por mês
├── metrics.jsonl           # dados do painel de monitoramento
├── birthdays.json / apelidos.txt / events.json / scheduled_messages.json  # você edita
└── regulamento.txt / megasena.txt
```

---

## 15. Observações importantes

- **Não é a API oficial da Meta.** Conexão não-oficial via protocolo do WhatsApp Web. Risco baixo de restrição pelo número, já que o bot majoritariamente só lê e responde a poucos comandos.
- **Privacidade:** `messages.jsonl` guarda o texto de todas as mensagens do grupo em texto puro. Ignorado pelo git, mas é dado sensível — fica na VM.
- **Crons perdidos:** todos usam `missedExecutionTolerance: 120000` (2 min de tolerância) pra não pular tarefa por atraso pequeno do timer.
- **Memória "RSS" alta:** é normal o processo do bot mostrar RSS bem maior que o heap JS real (ex: 500+ MB com heap de 50MB) depois de reconexões — é resíduo de buffer nativo (processamento de histórico do WhatsApp), não vazamento. Preocupa só se **continuar subindo sem parar** ou a VM ficar sem memória livre (o swap de 2GB é a rede de segurança pra isso).
- **Instabilidade de conexão (408/timeout):** se acontecer de novo uma sequência longa de quedas, olhe a aba Sistema do painel primeiro — a causa mais comum até hoje foi **duas instâncias do bot rodando ao mesmo tempo** (ex: um processo esquecido numa pasta de Startup do Windows, disputando a mesma sessão do WhatsApp com a instância "oficial"). Confirme com `pm2 list` (na VM) e `tasklist` (se ainda houver algo no Windows) que só existe uma instância ativa.
- **Debug:** rode com `DEBUG=1` no `.env` pra logar cada mensagem recebida e detalhes internos.
- Arquivos de dado pessoal/segredo (`birthdays.json`, `.env`, `audios/`, `regras/`, `avatars/`, etc.) não são versionados no git — cada instalação mantém os próprios.
