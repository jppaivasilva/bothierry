from lib import Diagram
W=1400; MX=550; MW=300; RX=1030; RW=330; LX=40; LW=330; H_=96; STEP=136; Y0=170
y=lambda i: Y0+i*STEP
d=Diagram(W, Y0+7*STEP+50, 'Uma pergunta ao bot', '(agente de IA)', 'Marcou o @Bothierry ou respondeu a ele? É isto que acontece.')
d.node('A',MX,y(0),MW,H_,'💬 @Bothierry ou reply','pode vir com foto')
d.node('B',MX,y(1),MW,H_,'Handler só enfileira','não espera a IA')
d.node('C',MX,y(2),MW,H_,'🗂️ Fila de IA','máx. 3 ao mesmo tempo · 1 por pessoa','hot')
d.node('D',MX,y(3),MW,H_+16,'Monta o prompt','persona + memória da pessoa + diário do bot + hora e conversa recente')
d.node('E',MX,y(4)+16,MW,H_,'🤖 Agente (agent.js)','a IA decide o próximo passo','hot')
d.node('F',RX,y(4)+16,RW,H_,'🔧 Chama funções','em paralelo, com timeout','ext')
d.node('F1',RX,y(5)+16,RW,H_+34,'o que ela consulta','grupo · cotação · tempo · futebol · notícias<br>busca na web · ler link · memória<br>lembretes · diário · insultos','ext')
d.node('G',MX,y(5)+16,MW,H_,'Resposta','')
d.node('H',MX,y(6)+16,MW,H_,'📤 Fila de envio → WhatsApp','em reply na mensagem original','hot')
d.node('L',LX,y(4)+16,LW,H_+16,'limites','5 passos · ~US$ 0,05 por pergunta<br>trava mensal (US$ 10) · traço na aba Agente','end')
for a,b in [('A','B'),('B','C'),('C','D'),('D','E'),('G','H')]:
    d.edge(a,'b',b,'t')
d.edge('E','b','G','t','pronto')
d.edge('E','r','F','l','precisa de dado',oa=-18,ob=-18,lpos=(940,y(4)+16+48-40))
d.edge('F','l','E','r','resultado',oa=18,ob=18,dash=True,lpos=(940,y(4)+16+48+40))
d.edge('L','r','E','l','protege',dash=True)
d.edge('F','b','F1','t',dash=True)
d.render('d4.html')
