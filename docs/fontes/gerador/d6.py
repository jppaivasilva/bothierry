from lib import Diagram
W=1400; H_=96
d=Diagram(W,1250,'Backup noturno','(03h40)','Um completo por dia, um por mês para sempre e o histórico de mensagens sempre protegido.')
MX=550; MW=300
d.node('A',MX,170,MW,H_,'⏰ Cron às 03h40','todo dia, horário de Brasília')
d.node('B',MX,306,MW,H_,'📦 Backup completo','um .tar.gz · sem .env e sem auth_info')
d.node('C',MX,442,MW,H_,'💾 backups/ na VM','7 mais recentes','hot')
d.node('D',MX,578,MW,H_,'Destino no Drive configurado?','BACKUP_RCLONE_REMOTE','dec')
d.node('F',1030,578,330,H_,'fim','fica só a cópia local','end')
# tres camadas
d.node('L1',40,780,400,140,'1 · Diário','o completo do dia na raiz da pasta<br/>apaga com mais de 15 dias<br/>(só os bothierry-*.tar.gz)','hot')
d.node('L2',500,780,400,140,'2 · Mensal','o 1º backup de cada mês<br/>vai para mensais/<br/>guardado PARA SEMPRE','hot')
d.node('L3',960,780,400,140,'3 · Histórico de mensagens','archive/ copiado de forma incremental<br/>só envia arquivo novo ou que cresceu<br/>NUNCA apaga nada','hot')
d.node('W',960,970,400,H_,'Arquivo local menor que o do Drive?','sinal de truncamento ou corrupção','dec')
d.node('X',960,1110,400,100,'⚠️ não envia','a cópia boa fica intacta · aviso em Erros recentes','warn')
d.node('T',40,970,860,240,'☁️ Google Drive · pasta bothierry-backups/',
 'bothierry-AAAA-MM-DD.tar.gz &nbsp;→ diários (15 dias)<br/>'
 'mensais/bothierry-AAAA-MM.tar.gz &nbsp;→ para sempre<br/>'
 'historico/archive/messages-AAAA-MM.jsonl &nbsp;→ para sempre<br/><br/>'
 'Falha em uma camada não derruba as outras.','store')
for a,b,l in [('A','B',None),('B','C',None),('C','D',None)]:
    d.edge(a,'b',b,'t',l)
d.edge('D','r','F','l','não')
d.edge('D','b','L1','t','sim',via=[(700,H_+578+30),(240,H_+578+30)],lpos=(700,H_+578+30))
d.edge('D','b','L2','t',via=[(700,H_+578+30),(700,780)]) if False else None
d.edge('D','b','L2','t',via=[(700,780-60),(700,780-60)])
d.edge('D','b','L3','t',via=[(700,H_+578+30),(1160,H_+578+30)])
d.edge('L3','b','W','t')
d.edge('W','b','X','t','sim')
d.edge('L1','b','T','t',dash=True,oa=0,ob=-200)
d.edge('L2','b','T','t',dash=True,ob=+200)
d.render('d6.html')
