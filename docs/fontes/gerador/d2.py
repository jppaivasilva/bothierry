from lib import Diagram
W=1400
actors=[('Membro','👤',150),('Grupo / WhatsApp','💬',430),('Bot','🤖',710),('Painel','📊',990),('events.json','📅',1250)]
X={n:x for n,_,x in actors}
STEP=92; Y0=330
H=Y0+9*STEP+210
d=Diagram(W,H,'Login no painel e presença','(!painel)','Como um membro entra pelo link de uso único e marca “Vou” num evento.')
for n,e,x in actors:
    cls='hot' if n=='Bot' else ('store' if n=='events.json' else '')
    d.node('a_'+n,x-105,160,210,76,f'{e} {n}','',cls)
    d.rawline([(x,240),(x,H-170)],dash=True)
msgs=[
 ('Membro','Grupo / WhatsApp','!painel',False),
 ('Grupo / WhatsApp','Bot','comando + jid do remetente',False),
 ('Bot','Painel','createLoginToken(jid, nome)',False),
 ('Bot','Membro','DM com link de uso único (5 min)',True),
 ('Bot','Grupo / WhatsApp','“te mandei o link no privado”',True),
 ('Membro','Painel','abre /entrar?t=TOKEN (só mostra o botão)',False),
 ('Membro','Painel','toca em “Entrar” (POST) → token consumido',False),
 ('Painel','Membro','cookie de sessão “member” (assinado)',True),
 ('Membro','Painel','aba Eventos → “✅ Vou”',False),
 ('Painel','events.json','addAttendee(evento, jid, nome)',False),
]
for i,(a,b,t,dash) in enumerate(msgs):
    y=Y0+i*STEP
    x1,x2=X[a],X[b]
    d.message(x1,x2,y,t,dash)
    d.raw(f'<div class="num" style="left:40px;top:{y}px">{i+1}</div>')
d.raw(f'<div class="note" style="left:330px;top:{Y0+9*STEP+60}px;width:840px;height:64px">📌 o !eventos no WhatsApp lê o mesmo arquivo (events.json)</div>')
d.render('d2.html')
