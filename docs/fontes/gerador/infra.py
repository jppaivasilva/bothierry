# Gera o infografico da infraestrutura (docs/infraestrutura.png). Saida: infraestrutura.html (1920x1080).
boxes = []
def box(x,y,w,h,title,sub='',cls=''):
    boxes.append(f'<div class="b {cls}" style="left:{x}px;top:{y}px;width:{w}px;height:{h}px"><b>{title}</b><small>{sub}</small></div>')

box(40,250,220,100,'📱 Celulares','grupo do WhatsApp')
box(370,250,220,100,'WhatsApp (Meta)','servidores do WhatsApp','ext')
box(40,560,220,100,'💻 Navegador','painel web, com login')
box(370,560,220,100,'☁️ Cloudflare','domínio + túnel seguro','ext')

VX,VY,VW,VH = 700,170,830,670
vm = f'<div class="vm" style="left:{VX}px;top:{VY}px;width:{VW}px;height:{VH}px"><div class="vmt">🖥️ VM na Oracle Cloud · Ubuntu 24.04</div></div>'
cw,ch=240,100
cx=[730,1000,1270]
ry=[250,400,550]
box(cx[0],ry[0],cw,ch,'🔌 Baileys','conexão com o WhatsApp','hot')
box(cx[1],ry[0],cw,ch,'🧠 Handler','comandos, regras, fotos e menções')
box(cx[2],ry[0],cw,ch,'🤖 Agente de IA','fila · memória · ferramentas · visão')
box(cx[0],ry[1],cw,ch,'📊 Painel web','só local (127.0.0.1:4321)')
box(cx[1],ry[1],cw,ch,'📤 Fila de envio','intervalo + reenvio → Baileys')
box(cx[2],ry[1],cw,ch,'⏰ Rotinas (cron)','bom dia, aniversário, lembretes, status')
box(cx[0],ry[2],cw,ch,'🚇 cloudflared','túnel de saída, sem porta aberta')
box(cx[1],ry[2],cw,ch,'⚙️ Node.js + PM2','mantém o bot sempre ligado')
box(cx[2],ry[2],cw,ch,'🔄 deploy.sh','atualiza e volta atrás se falhar')
box(730,700,780,115,'💾 Dados locais (arquivos)','mensagens · memória · lembretes · diário do bot · sessão do WhatsApp<br><span class="ok">✅ backup diário (7 na VM) + Google Drive: mensal e histórico para sempre</span>','store')

ex=[('🧠 OpenAI','chat · imagens · áudio'),('🔎 Tavily','busca na web'),('⛅ Open-Meteo','previsão do tempo'),('📈 Yahoo Finance','cotações'),('⚽ football-data','placares de futebol'),('📰 RSS','IGN · Canaltech · G1'),('☁️ Google Drive','diários · mensais · histórico')]
EXX=1650; EXW=230; EY0=205; EH=78; EG=10
for i,(t,s) in enumerate(ex):
    box(EXX,EY0+i*(EH+EG),EXW,EH,t,s,'ext')
boxes.append(f'<div class="colt" style="left:{EXX-20}px;top:165px;width:{EXW+40}px">Serviços externos</div>')

PY=905
box(40,PY,230,105,'👩‍💻 Código','dono + Claude Code')
box(340,PY,230,105,'🐙 GitHub','pull request na main')
box(640,PY,250,105,'✅ GitHub Actions','eslint + testes automáticos','ci')
box(960,PY,230,105,'🔀 Merge','só com testes verdes')
box(1260,PY,270,105,'🖥️ VM busca a versão','verifica, instala e reinicia','hot')
box(EXX,PY,EXW,105,'🩺 UptimeRobot','avisa se /health cair','ext')

def arr(x1,y1,x2,y2,both=False,dash=False):
    d=' stroke-dasharray="8 7"' if dash else ''
    ms=' marker-start="url(#s)"' if both else ''
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}"{ms} marker-end="url(#a)"{d}/>'
lines=[
 arr(264,300,366,300,True), arr(594,300,726,300,True),
 arr(264,610,366,610,True), arr(594,610,726,610,True),
 arr(974,300,996,300), arr(1244,300,1266,300),
 arr(1120,354,1120,396), arr(850,546,850,504),
 arr(1534,510,1596,510),
 arr(264,957,336,957), arr(574,957,636,957), arr(894,957,956,957), arr(1194,957,1256,957),
 arr(1534,957,1646,957,dash=True),
]
cy=[EY0+EH//2+i*(EH+EG) for i in range(len(ex))]
trunk=f'<line x1="1596" y1="{cy[0]}" x2="1596" y2="{cy[-1]}" />'
branches=''.join(arr(1596,y,1644,y) for y in cy)
svg=f'''<svg class="arrows" width="1920" height="1080" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">
<defs>
<marker id="a" markerUnits="userSpaceOnUse" markerWidth="16" markerHeight="16" refX="13" refY="8" orient="auto"><path d="M1,1 L15,8 L1,15 z" fill="#3ddc97"/></marker>
<marker id="s" markerUnits="userSpaceOnUse" markerWidth="16" markerHeight="16" refX="3" refY="8" orient="auto-start-reverse"><path d="M1,1 L15,8 L1,15 z" fill="#3ddc97"/></marker>
</defs>
<g stroke="#3ddc97" stroke-width="3.5" fill="none" stroke-linecap="round">{''.join(lines)}{trunk}{branches}</g></svg>'''
labels='''
<div class="lab" style="left:264px;top:268px;width:102px;text-align:center">WhatsApp Web</div>
<div class="lab" style="left:594px;top:268px;width:104px;text-align:center">WebSocket</div>
<div class="lab" style="left:264px;top:578px;width:102px;text-align:center">HTTPS</div>
<div class="lab" style="left:594px;top:578px;width:104px;text-align:center">túnel</div>
<div class="lab" style="left:1132px;top:362px">resposta</div>
<div class="lab" style="left:862px;top:512px">painel</div>
<div class="lab" style="left:1534px;top:482px;width:62px;text-align:center">HTTPS</div>
<div class="lab" style="left:1534px;top:975px;width:112px;text-align:center">monitora</div>
<div class="sect" style="left:40px;top:200px">QUEM USA</div>
<div class="sect" style="left:370px;top:200px">INTERNET</div>
<div class="sect" style="left:40px;top:862px">DESENVOLVIMENTO E DEPLOY</div>
'''
html=f'''<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=1920">
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{width:1920px;height:1080px;background:#0f1d1a;color:#e9f5f1;font-family:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;position:relative;overflow:hidden}}
h1{{position:absolute;left:40px;top:28px;font-size:52px;font-weight:800;letter-spacing:-1px}}
h1 span{{color:#3ddc97}}
.sub{{position:absolute;left:40px;top:96px;font-size:24px;color:#9fc4b8}}
.b{{position:absolute;background:#173028;border:2px solid #25503f;border-radius:18px;padding:12px 14px;display:flex;flex-direction:column;justify-content:center;text-align:center}}
.b b{{font-size:23px;line-height:1.15;white-space:nowrap}}
.b small{{font-size:16.5px;color:#a9d1c4;margin-top:6px;line-height:1.25}}
.b.hot{{background:#1f4a39;border-color:#3ddc97}}
.b.ext{{background:#1b2a3a;border-color:#3b5f86}}
.b.ci{{background:#2a2a14;border-color:#c9b43c}}
.b.store{{background:#1b2d35;border-color:#3a7f93}}
.ok{{display:inline-block;margin-top:8px;border:2px solid #3ddc97;border-radius:10px;padding:4px 12px;color:#cfeee2;background:rgba(61,220,151,.10)}}
.vm{{position:absolute;border:3px dashed #3ddc97;border-radius:28px;background:rgba(61,220,151,.05)}}
.vmt{{position:absolute;top:14px;left:26px;font-size:24px;font-weight:800;color:#3ddc97}}
.arrows{{position:absolute;left:0;top:0;pointer-events:none}}
.lab{{position:absolute;font-size:15px;color:#9fc4b8;white-space:nowrap}}
.sect{{position:absolute;font-size:16px;letter-spacing:2px;font-weight:800;color:#6f9a8c}}
.colt{{position:absolute;font-size:16px;letter-spacing:2px;font-weight:800;color:#6f9a8c;text-align:center;text-transform:uppercase}}
.note{{position:absolute;left:40px;top:1036px;font-size:17px;color:#6f9a8c}}
</style></head><body>
<h1>Infraestrutura do <span>Bothierry</span></h1>
<div class="sub">Um único processo Node.js numa VM na nuvem, ligado ao WhatsApp pelo Baileys e atualizado automaticamente a cada versão aprovada.</div>
{vm}
{''.join(boxes)}
{svg}
{labels}
<div class="note">Chaves e senhas ficam só em arquivo de configuração na VM (nunca no código). O painel não tem porta aberta na internet: só é acessado pelo túnel da Cloudflare.</div>
</body></html>'''
open('infraestrutura.html','w').write(html)
