# Fontes dos diagramas do README

As imagens `docs/fluxo-*.png` (e o infográfico `docs/infraestrutura.png`) seguem o mesmo estilo visual: fundo verde-escuro, caixas arredondadas, setas em verde-menta.

- `fluxo-d1.html` … `fluxo-d6.html` e `infraestrutura.html`: o HTML de cada diagrama (abre em qualquer navegador).
- `gerador/`: o código Python que gera esses HTML (`lib.py` é o mini-motor de layout; `d1.py` … `d6.py` descrevem cada fluxograma; `infra.py` gera o infográfico da infraestrutura, 1920×1080) e `shot.cjs`, que tira o screenshot com o Playwright.

Para refazer um diagrama (na pasta `docs/fontes/gerador/`):

```bash
python3 d4.py                       # gera d4.html
node shot.cjs "$PWD/d4.html" "$PWD/d4.png" 1400 <altura>   # a altura está no final do HTML (height:NNNpx)
```

Depois reduza a imagem (largura 1800) e substitua o PNG em `docs/`. Mapa: d1 = mensagem, d2 = login no painel, d3 = deploy, d4 = agente de IA, d5 = fila de envio, d6 = backup noturno.
