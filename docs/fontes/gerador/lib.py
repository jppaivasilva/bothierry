# Mini-motor de diagramas no estilo do infografico (fundo verde-escuro, caixas arredondadas, setas menta).
CSS = """
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f1d1a;color:#e9f5f1;font-family:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;position:relative;overflow:hidden}
h1{position:absolute;left:40px;top:28px;font-size:48px;font-weight:800;letter-spacing:-1px}
h1 span{color:#3ddc97}
.sub{position:absolute;left:40px;top:92px;font-size:22px;color:#9fc4b8}
.b{position:absolute;background:#173028;border:2px solid #25503f;border-radius:18px;padding:10px 14px;display:flex;flex-direction:column;justify-content:center;text-align:center}
.b b{font-size:22px;line-height:1.18}
.b small{font-size:16.5px;color:#a9d1c4;margin-top:5px;line-height:1.25}
.b.hot{background:#1f4a39;border-color:#3ddc97}
.b.ext{background:#1b2a3a;border-color:#3b5f86}
.b.dec{background:#2a2a14;border-color:#c9b43c}
.b.end{background:#1c2623;border-color:#3d4f49;border-style:dashed}
.b.end b,.b.end small{color:#9fb5ad}
.b.warn{background:#33201d;border-color:#d9776a}
.b.store{background:#1b2d35;border-color:#3a7f93}
.arrows{position:absolute;left:0;top:0;pointer-events:none}
.lab{position:absolute;font-size:16px;color:#bfe3d6;white-space:nowrap;background:#0f1d1a;padding:1px 9px;border-radius:9px;transform:translate(-50%,-50%);line-height:1.25}
.lab.alt{color:#ffe08a}
.num{position:absolute;width:34px;height:34px;border-radius:50%;background:#3ddc97;color:#0f1d1a;font-weight:800;font-size:20px;display:flex;align-items:center;justify-content:center;transform:translate(-50%,-50%)}
.note{position:absolute;background:#2a2a14;border:2px solid #c9b43c;border-radius:16px;padding:12px 18px;font-size:19px;color:#fbe7b0;text-align:center;display:flex;align-items:center;justify-content:center}
.foot{position:absolute;left:40px;font-size:16px;color:#6f9a8c}
"""
class Diagram:
    def __init__(self, W, H, title, accent, sub, foot=None):
        self.W, self.H, self.title, self.accent, self.sub, self.foot = W, H, title, accent, sub, foot
        self.nodes, self.html, self.lines, self.labels = {}, [], [], []
    def node(self, id, x, y, w, h, title, sub='', cls=''):
        self.nodes[id] = (x, y, w, h)
        s = f'<small>{sub}</small>' if sub else ''
        self.html.append(f'<div class="b {cls}" style="left:{x}px;top:{y}px;width:{w}px;height:{h}px"><b>{title}</b>{s}</div>')
    def pt(self, id, side, off=0):
        x, y, w, h = self.nodes[id]
        return {'t': (x + w/2 + off, y), 'b': (x + w/2 + off, y + h), 'l': (x, y + h/2 + off), 'r': (x + w, y + h/2 + off)}[side]
    def edge(self, a, sa, b, sb, label=None, dash=False, oa=0, ob=0, via=None, both=False, alt=False, lpos=None):
        p1, p2 = self.pt(a, sa, oa), self.pt(b, sb, ob)
        if via is not None:
            pts = [p1] + via + [p2]
        else:
            hor = lambda s: s in 'lr'
            if hor(sa) and hor(sb):
                pts = [p1, p2] if abs(p1[1]-p2[1]) < 1 else [p1, ((p1[0]+p2[0])/2, p1[1]), ((p1[0]+p2[0])/2, p2[1]), p2]
            elif not hor(sa) and not hor(sb):
                pts = [p1, p2] if abs(p1[0]-p2[0]) < 1 else [p1, (p1[0], (p1[1]+p2[1])/2), (p2[0], (p1[1]+p2[1])/2), p2]
            elif hor(sa):
                pts = [p1, (p2[0], p1[1]), p2]
            else:
                pts = [p1, (p1[0], p2[1]), p2]
        d = ' stroke-dasharray="9 7"' if dash else ''
        ms = ' marker-start="url(#s)"' if both else ''
        self.lines.append(f'<polyline points="{" ".join(f"{x:.1f},{y:.1f}" for x, y in pts)}" marker-end="url(#a)"{ms}{d}/>')
        if label:
            if lpos: lx, ly = lpos
            else:
                best = max(range(len(pts)-1), key=lambda i: abs(pts[i][0]-pts[i+1][0]) + abs(pts[i][1]-pts[i+1][1]))
                (x1, y1), (x2, y2) = pts[best], pts[best+1]
                lx, ly = (x1+x2)/2, (y1+y2)/2
            self.labels.append(f'<div class="lab{" alt" if alt else ""}" style="left:{lx:.0f}px;top:{ly:.0f}px">{label}</div>')
    def raw(self, s): self.html.append(s)
    def rawline(self, pts, color='#25503f', width=2, dash=False):
        d = ' stroke-dasharray="8 8"' if dash else ''
        self.lines.append(f'<polyline points="{" ".join(f"{x:.1f},{y:.1f}" for x, y in pts)}" stroke="{color}" stroke-width="{width}"{d} marker-end="none"/>')
    def message(self, x1, x2, y, text, dash=False):
        self.lines.append(f'<polyline points="{x1},{y} {x2},{y}" marker-end="url(#a)"{" stroke-dasharray=&quot;9 7&quot;" if dash else ""}/>')
        self.labels.append(f'<div class="lab" style="left:{(x1+x2)/2:.0f}px;top:{y-20}px;font-size:18px">{text}</div>')
    def render(self, path):
        svg = f'''<svg class="arrows" width="{self.W}" height="{self.H}" viewBox="0 0 {self.W} {self.H}" xmlns="http://www.w3.org/2000/svg"><defs>
<marker id="a" markerUnits="userSpaceOnUse" markerWidth="16" markerHeight="16" refX="13" refY="8" orient="auto"><path d="M1,1 L15,8 L1,15 z" fill="#3ddc97"/></marker>
<marker id="s" markerUnits="userSpaceOnUse" markerWidth="16" markerHeight="16" refX="3" refY="8" orient="auto-start-reverse"><path d="M1,1 L15,8 L1,15 z" fill="#3ddc97"/></marker></defs>
<g stroke="#3ddc97" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round">{"".join(self.lines)}</g></svg>'''
        foot = f'<div class="foot" style="top:{self.H-34}px">{self.foot}</div>' if self.foot else ''
        open(path, 'w').write(f'<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width={self.W}"><style>{CSS}body{{width:{self.W}px;height:{self.H}px}}</style></head><body><h1>{self.title} <span>{self.accent}</span></h1><div class="sub">{self.sub}</div>{"".join(self.html)}{svg}{"".join(self.labels)}{foot}</body></html>')
