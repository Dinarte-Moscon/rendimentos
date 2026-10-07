"""Servidor web local do controle de rendimentos (somente biblioteca padrão do Python).

Uso: python app.py [--porta 8765] [--sem-navegador]
"""
import argparse
import json
import mimetypes
import os
import re
import threading
import webbrowser
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import bcb
import db
from calc import Motor, fim_mes

STATIC_DIR = os.path.join(db.BASE_DIR, "static")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("text/javascript", ".js")
TIPOS = ("CDI", "SELIC", "PRE", "IPCA", "MENSAL")


class ErroValidacao(Exception):
    pass


def num(v, campo):
    try:
        if isinstance(v, str):
            v = v.strip().replace(".", "").replace(",", ".") if "," in v else v.strip()
        return float(v)
    except (TypeError, ValueError):
        raise ErroValidacao(f"Valor inválido em '{campo}'.")


def data_iso(v, campo="data"):
    try:
        return date.fromisoformat(v).isoformat()
    except (TypeError, ValueError):
        raise ErroValidacao(f"Data inválida em '{campo}'.")


def mes_iso(v):
    if not isinstance(v, str) or not re.fullmatch(r"\d{4}-\d{2}", v):
        raise ErroValidacao("Mês inválido (use AAAA-MM).")
    return v


def r2(v):
    return None if v is None else round(v, 2)


# ------------------------------------------------------------------ rotas
ROTAS = []


def rota(metodo, padrao):
    def deco(fn):
        ROTAS.append((metodo, re.compile("^" + padrao + "$"), fn))
        return fn
    return deco


@rota("GET", "/api/config")
def get_config(con, q, body):
    return db.ler_config(con)


@rota("POST", "/api/config")
def post_config(con, q, body):
    permitidos = {"data_inicio": data_iso, "data_meta": data_iso,
                  "spread_cdi": lambda v, c=None: str(num(v, "spread_cdi")),
                  "ipca_projetado": lambda v, c=None: str(num(v, "ipca_projetado")),
                  "cenario_variacao": lambda v, c=None: str(abs(num(v, "cenario_variacao")))}
    for k, v in body.items():
        if k in permitidos:
            con.execute("UPDATE config SET valor=? WHERE chave=?", (permitidos[k](v, k), k))
    return db.ler_config(con)


# ---- aplicações
@rota("GET", "/api/aplicacoes")
def get_aplicacoes(con, q, body):
    return [dict(r) for r in con.execute("SELECT * FROM aplicacao ORDER BY ordem, id")]


@rota("POST", "/api/aplicacoes")
def post_aplicacao(con, q, body):
    nome = (body.get("nome") or "").strip()
    if not nome:
        raise ErroValidacao("Informe o nome da aplicação.")
    tipo = body.get("tipo")
    if tipo not in TIPOS:
        raise ErroValidacao("Tipo de rendimento inválido.")
    taxa = num(body.get("taxa", 100), "taxa")
    ativa = 1 if body.get("ativa", True) else 0
    enc = data_iso(body["data_encerramento"], "encerramento") if body.get("data_encerramento") else None
    if body.get("id"):
        con.execute("UPDATE aplicacao SET nome=?, instituicao=?, tipo=?, taxa=?, ativa=?, data_encerramento=? WHERE id=?",
                    (nome, body.get("instituicao"), tipo, taxa, ativa, enc, int(body["id"])))
        return {"id": int(body["id"])}
    ordem = con.execute("SELECT COALESCE(MAX(ordem), 0) + 1 FROM aplicacao").fetchone()[0]
    cur = con.execute("INSERT INTO aplicacao (nome, instituicao, tipo, taxa, ativa, data_encerramento, ordem) VALUES (?,?,?,?,?,?,?)",
                      (nome, body.get("instituicao"), tipo, taxa, ativa, enc, ordem))
    return {"id": cur.lastrowid}


@rota("DELETE", r"/api/aplicacoes/(\d+)")
def del_aplicacao(con, q, body, id_):
    usado = con.execute("SELECT (SELECT COUNT(*) FROM saldo WHERE aplicacao_id=?) + (SELECT COUNT(*) FROM movimento WHERE aplicacao_id=?)",
                        (id_, id_)).fetchone()[0]
    if usado:
        raise ErroValidacao("A aplicação tem lançamentos. Para tirá-la do lançamento diário, marque-a como encerrada.")
    con.execute("DELETE FROM aplicacao WHERE id=?", (id_,))
    return {"ok": True}


# ---- lançamento diário de saldos
@rota("GET", "/api/lancamento")
def get_lancamento(con, q, body):
    dia = date.fromisoformat(q.get("data", [date.today().isoformat()])[0])
    m = Motor(con, hoje=max(dia, date.today()))
    # média de rendimento por dia útil de cada aplicação nos 60 dias anteriores (para alertar valores fora do padrão)
    medias = {}
    for l in m.rendimento_diario(desde=dia - timedelta(days=60), ate=dia - timedelta(days=1)):
        acc = medias.setdefault(l["aplicacao_id"], [0.0, 0])
        acc[0] += l["rendimento"]
        acc[1] += l["dias_uteis"]
    itens = []
    for app in m.apps:
        lanc = con.execute("SELECT id, valor FROM saldo WHERE aplicacao_id=? AND data=?", (app["id"], dia.isoformat())).fetchone()
        ant = m.ultimo_saldo(app["id"], dia - timedelta(days=1))
        if not app["ativa"] and not lanc:
            continue
        mov = m.mov_soma(app["id"], ant[0], dia, incl_a=False) if ant else m.mov_soma(app["id"], date(1900, 1, 1), dia)
        acc = medias.get(app["id"])
        item = {"aplicacao_id": app["id"], "nome": app["nome"], "instituicao": app["instituicao"],
                "saldo_id": lanc["id"] if lanc else None,
                "dias_uteis": m.cal.dias_uteis(ant[0], dia) if ant else None,
                "media_du": r2(acc[0] / acc[1]) if acc and acc[1] else None,
                "saldo": lanc["valor"] if lanc else None,
                "anterior_data": ant[0].isoformat() if ant else None, "anterior_valor": ant[1] if ant else None,
                "movimento": r2(mov),
                "estimado": r2(m.saldo_em(app, dia)) if ant else None}
        if lanc and ant:
            item["rendimento"] = r2(lanc["valor"] - ant[1] - mov)
        itens.append(item)
    movs = [dict(r) for r in con.execute(
        "SELECT m.id, m.aplicacao_id, a.nome, m.valor, m.descricao FROM movimento m JOIN aplicacao a ON a.id=m.aplicacao_id WHERE m.data=? ORDER BY m.id",
        (dia.isoformat(),))]
    return {"data": dia.isoformat(), "util": m.cal.util(dia), "itens": itens, "movimentos": movs}


@rota("POST", "/api/lancamento")
def post_lancamento(con, q, body):
    dia = data_iso(body.get("data"))
    gravados = 0
    for it in body.get("itens", []):
        app_id = int(it["aplicacao_id"])
        v = it.get("saldo")
        if v in (None, ""):
            con.execute("DELETE FROM saldo WHERE aplicacao_id=? AND data=?", (app_id, dia))
            continue
        con.execute("INSERT INTO saldo (aplicacao_id, data, valor) VALUES (?,?,?) "
                    "ON CONFLICT(aplicacao_id, data) DO UPDATE SET valor=excluded.valor",
                    (app_id, dia, num(v, "saldo")))
        gravados += 1
    return {"gravados": gravados}


@rota("GET", "/api/historico")
def get_historico(con, q, body):
    dias = int(q.get("dias", ["45"])[0])
    m = Motor(con)
    desde = date.today() - timedelta(days=dias)
    nomes = {a["id"]: a["nome"] for a in m.apps}
    linhas = m.rendimento_diario(desde=desde)
    for l in linhas:
        l["nome"] = nomes[l["aplicacao_id"]]
        for k in ("saldo", "saldo_anterior", "movimento", "rendimento"):
            l[k] = r2(l[k])
    linhas.sort(key=lambda x: (x["data"], x["aplicacao_id"]), reverse=True)
    return linhas


# ---- movimentos
@rota("GET", "/api/movimentos")
def get_movimentos(con, q, body):
    sql = "SELECT m.*, a.nome FROM movimento m JOIN aplicacao a ON a.id=m.aplicacao_id"
    args = []
    if q.get("aplicacao"):
        sql += " WHERE m.aplicacao_id=?"
        args.append(int(q["aplicacao"][0]))
    return [dict(r) for r in con.execute(sql + " ORDER BY m.data DESC, m.id DESC", args)]


@rota("POST", "/api/movimentos")
def post_movimento(con, q, body):
    dados = (int(body["aplicacao_id"]), data_iso(body.get("data")), num(body.get("valor"), "valor"), body.get("descricao"))
    if dados[2] == 0:
        raise ErroValidacao("O valor do movimento não pode ser zero.")
    if body.get("id"):
        con.execute("UPDATE movimento SET aplicacao_id=?, data=?, valor=?, descricao=? WHERE id=?", dados + (int(body["id"]),))
        return {"id": int(body["id"])}
    return {"id": con.execute("INSERT INTO movimento (aplicacao_id, data, valor, descricao) VALUES (?,?,?,?)", dados).lastrowid}


@rota("DELETE", r"/api/movimentos/(\d+)")
def del_movimento(con, q, body, id_):
    con.execute("DELETE FROM movimento WHERE id=?", (id_,))
    return {"ok": True}


# ---- Selic
@rota("GET", "/api/selic")
def get_selic(con, q, body):
    return [dict(r) for r in con.execute("SELECT * FROM selic ORDER BY vigencia")]


@rota("POST", "/api/selic")
def post_selic(con, q, body):
    vig, taxa = data_iso(body.get("vigencia"), "vigência"), num(body.get("taxa_aa"), "taxa")
    if body.get("id"):
        con.execute("UPDATE selic SET vigencia=?, taxa_aa=?, origem='manual' WHERE id=?", (vig, taxa, int(body["id"])))
    else:
        con.execute("INSERT INTO selic (vigencia, taxa_aa, origem) VALUES (?,?,'manual') "
                    "ON CONFLICT(vigencia) DO UPDATE SET taxa_aa=excluded.taxa_aa, origem='manual'", (vig, taxa))
    return {"ok": True}


@rota("DELETE", r"/api/selic/(\d+)")
def del_selic(con, q, body, id_):
    con.execute("DELETE FROM selic WHERE id=?", (id_,))
    return {"ok": True}


def atualizar_selic_bcb(con):
    """Substitui o histórico (até hoje) pelas mudanças da meta Selic publicadas pelo BCB."""
    cfg = db.ler_config(con)
    desde = date.fromisoformat(cfg["data_inicio"]) - timedelta(days=400)
    hoje = date.today()
    mud = bcb.historico_selic(desde, hoje)
    con.execute("DELETE FROM selic WHERE vigencia <= ?", (hoje.isoformat(),))
    for dt, taxa in mud:
        con.execute("INSERT INTO selic (vigencia, taxa_aa, origem) VALUES (?,?,'bcb') "
                    "ON CONFLICT(vigencia) DO UPDATE SET taxa_aa=excluded.taxa_aa, origem='bcb'", (dt.isoformat(), taxa))
    return mud


@rota("POST", "/api/selic/bcb")
def post_selic_bcb(con, q, body):
    mud = atualizar_selic_bcb(con)
    return {"atual": mud[-1][1], "desde": mud[-1][0].isoformat(), "mudancas": len(mud)}


@rota("POST", "/api/selic/focus")
def post_selic_focus(con, q, body):
    mud = atualizar_selic_bcb(con)
    atual = mud[-1][1]
    data_focus, anos = bcb.focus_selic_anual()
    cfg = db.ler_config(con)
    hoje = date.today()
    curva = bcb.curva_focus(atual, hoje, anos, fim_mes(date.fromisoformat(cfg["data_meta"])))
    con.execute("DELETE FROM selic WHERE vigencia > ?", (hoje.isoformat(),))
    for dt, taxa in curva:
        con.execute("INSERT INTO selic (vigencia, taxa_aa, origem) VALUES (?,?,'focus')", (dt.isoformat(), taxa))
    con.execute("UPDATE config SET valor=? WHERE chave='focus_ultima_busca'", (data_focus,))
    return {"data_focus": data_focus, "anos": anos, "atual": atual, "pontos": len(curva)}


@rota("POST", "/api/selic/limpar-futuro")
def post_selic_limpar(con, q, body):
    con.execute("DELETE FROM selic WHERE vigencia > ?", (date.today().isoformat(),))
    return {"ok": True}


# ---- aportes planejados
@rota("GET", "/api/planejados")
def get_planejados(con, q, body):
    return [dict(r) for r in con.execute(
        "SELECT p.*, a.nome FROM aporte_planejado p JOIN aplicacao a ON a.id=p.aplicacao_id ORDER BY p.mes, a.ordem")]


@rota("POST", "/api/planejados")
def post_planejado(con, q, body):
    """Grava o mesmo valor para cada mês do intervalo (de/ate) da aplicação."""
    app_id = int(body["aplicacao_id"])
    de, ate = mes_iso(body.get("de")), mes_iso(body.get("ate") or body.get("de"))
    valor = num(body.get("valor"), "valor")
    so_meses = set(int(x) for x in body.get("meses") or []) or set(range(1, 13))
    a, m = int(de[:4]), int(de[5:])
    n = 0
    while f"{a:04d}-{m:02d}" <= ate:
        if m in so_meses:
            if valor == 0:
                con.execute("DELETE FROM aporte_planejado WHERE aplicacao_id=? AND mes=?", (app_id, f"{a:04d}-{m:02d}"))
            else:
                con.execute("INSERT INTO aporte_planejado (aplicacao_id, mes, valor) VALUES (?,?,?) "
                            "ON CONFLICT(aplicacao_id, mes) DO UPDATE SET valor=excluded.valor", (app_id, f"{a:04d}-{m:02d}", valor))
            n += 1
        m += 1
        if m > 12:
            a, m = a + 1, 1
    return {"meses": n}


@rota("DELETE", r"/api/planejados/(\d+)")
def del_planejado(con, q, body, id_):
    con.execute("DELETE FROM aporte_planejado WHERE id=?", (id_,))
    return {"ok": True}


# ---- feriados
@rota("GET", "/api/feriados")
def get_feriados(con, q, body):
    ano = q.get("ano", [str(date.today().year)])[0]
    return [dict(r) for r in con.execute("SELECT * FROM feriado WHERE substr(data,1,4)=? ORDER BY data", (ano,))]


@rota("POST", "/api/feriados")
def post_feriado(con, q, body):
    con.execute("INSERT OR REPLACE INTO feriado (data, descricao) VALUES (?,?)", (data_iso(body.get("data")), body.get("descricao")))
    return {"ok": True}


@rota("DELETE", r"/api/feriados/(\d{4}-\d{2}-\d{2})")
def del_feriado(con, q, body, dia):
    con.execute("DELETE FROM feriado WHERE data=?", (dia,))
    return {"ok": True}


# ---- dashboard
def _ids(q):
    if q.get("aplicacao") and q["aplicacao"][0] not in ("", "todas"):
        return {int(x) for x in q["aplicacao"][0].split(",")}
    return None


def _resumo(m, apps, meses_):
    hoje = m.hoje
    atual = next((x for x in meses_ if x["mes"] == hoje.strftime("%Y-%m")), None)
    datas = [m.ultimo_saldo(a["id"], hoje) for a in apps]
    data_ref = max((x[0] for x in datas if x), default=None)
    return {
        "patrimonio": r2(sum(m.saldo_real(a["id"], hoje) for a in apps)),
        "patrimonio_data": data_ref.isoformat() if data_ref else None,
        "mes_parcial": r2(atual["parcial"]) if atual else None,
        "mes_parcial_ate": atual["parcial_ate"] if atual else None,
        "selic_atual": round(m.selic_em(hoje) * 100, 2),
    }, atual


@rota("GET", "/api/resumo")
def get_resumo(con, q, body):
    m = Motor(con)
    apps, meses_ = m.consolidado()
    return _resumo(m, apps, meses_)[0]


@rota("GET", "/api/dashboard")
def get_dashboard(con, q, body):
    m = Motor(con)
    ids = _ids(q)
    apps, meses_ = m.consolidado(ids)
    hoje = m.hoje
    resumo, atual = _resumo(m, apps, meses_)
    ultimo = meses_[-1] if meses_ else None
    i_atual = meses_.index(atual) if atual else len(meses_) - 1
    anterior_mes = meses_[i_atual - 1] if i_atual > 0 else None

    realizado_total = sum(x["rendimento"] for x in meses_ if x["status"] == "realizado")
    if atual and atual["parcial"] is not None:
        realizado_total += atual["parcial"]

    # cenários: Selic futura deslocada para baixo e para cima
    var = float(m.cfg.get("cenario_variacao") or 0)
    cenarios = {}
    if var:
        for nome, delta in (("baixo", -var), ("alto", var)):
            _, ms = Motor(con, delta_selic=delta).consolidado(ids)
            cenarios[nome] = [r2(x["final"]) for x in ms]

    # rendimento por lançamento no mês corrente e último lançamento
    ini_mes = hoje.replace(day=1)
    diario = {}
    for l in m.rendimento_diario(ids, desde=ini_mes - timedelta(days=45), ate=hoje):
        dd = diario.setdefault(l["data"], {"data": l["data"], "rendimento": 0.0, "dias_uteis": 0})
        dd["rendimento"] += l["rendimento"]
        dd["dias_uteis"] = max(dd["dias_uteis"], l["dias_uteis"])
    diario = sorted(diario.values(), key=lambda v: v["data"])
    ult_lanc = diario[-1] if diario else None
    diario_mes = [v for v in diario if v["data"] >= ini_mes.isoformat()]

    distrib = [{"id": a["id"], "nome": a["nome"], "saldo": r2(m.saldo_real(a["id"], hoje))} for a in apps]
    distrib = [x for x in distrib if abs(x["saldo"]) > 0.005]

    def limpa(x):
        return {k: (r2(v) if isinstance(v, float) and k not in ("percentual", "cdi_mes") else v) for k, v in x.items()}

    kpis = dict(resumo)
    kpis.update({
        "mes_dias_uteis": atual["dias_uteis"] if atual else None,
        "mes_dias_uteis_total": m.cal.dias_uteis(ini_mes - timedelta(days=1), fim_mes(hoje)),
        "mes_projetado": r2(atual["rendimento"]) if atual else None,
        "mes_anterior": anterior_mes["mes"] if anterior_mes else None,
        "mes_anterior_rendimento": r2(anterior_mes["rendimento"]) if anterior_mes else None,
        "mes_anterior_final": r2(anterior_mes["final"]) if anterior_mes else None,
        "realizado_total": r2(realizado_total),
        "ultimo_lancamento": {"data": ult_lanc["data"], "rendimento": r2(ult_lanc["rendimento"]),
                              "dias_uteis": ult_lanc["dias_uteis"]} if ult_lanc else None,
        "meta_data": ultimo["mes"] if ultimo else None,
        "meta_final": r2(ultimo["final"]) if ultimo else None,
        "meta_rendimento": r2(ultimo["rendimento"]) if ultimo else None,
        "cenario_variacao": var,
    })
    return {
        "hoje": hoje.isoformat(),
        "aplicacoes": [{"id": a["id"], "nome": a["nome"], "ativa": a["ativa"]} for a in apps],
        "kpis": kpis,
        "meses": [limpa(x) for x in meses_],
        "cenarios": cenarios,
        "diario": [{"data": v["data"], "rendimento": r2(v["rendimento"]), "dias_uteis": v["dias_uteis"]} for v in diario_mes],
        "distribuicao": distrib,
    }


# ------------------------------------------------------------------ servidor
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, status, dados):
        corpo = json.dumps(dados, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(corpo)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(corpo)

    def _static(self, caminho):
        if caminho in ("", "/"):
            caminho = "/index.html"
        arq = os.path.normpath(os.path.join(STATIC_DIR, caminho.lstrip("/")))
        if not arq.startswith(STATIC_DIR) or not os.path.isfile(arq):
            self.send_error(404)
            return
        with open(arq, "rb") as f:
            corpo = f.read()
        tipo = mimetypes.guess_type(arq)[0] or "application/octet-stream"
        if tipo.startswith("text/") or tipo.endswith("javascript"):
            tipo += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(corpo)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(corpo)

    def _api(self, metodo):
        url = urlparse(self.path)
        for met, padrao, fn in ROTAS:
            mt = padrao.match(url.path)
            if met == metodo and mt:
                body = {}
                tam = int(self.headers.get("Content-Length") or 0)
                if tam:
                    body = json.loads(self.rfile.read(tam).decode("utf-8") or "{}")
                try:
                    with db.conectar() as con:
                        res = fn(con, parse_qs(url.query), body, *mt.groups())
                    self._json(200, res)
                except ErroValidacao as e:
                    self._json(400, {"erro": str(e)})
                except bcb.ErroBCB as e:
                    self._json(502, {"erro": str(e)})
                except Exception as e:
                    self._json(500, {"erro": f"Erro interno: {e}"})
                return
        self._json(404, {"erro": "Rota não encontrada."})

    def do_GET(self):
        if self.path.startswith("/api/"):
            self._api("GET")
        else:
            self._static(urlparse(self.path).path)

    def do_POST(self):
        self._api("POST")

    def do_DELETE(self):
        self._api("DELETE")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--porta", type=int, default=8765)
    ap.add_argument("--sem-navegador", action="store_true")
    args = ap.parse_args()
    db.inicializar()
    with db.conectar() as con:
        if con.execute("SELECT COUNT(*) FROM selic").fetchone()[0] == 0:
            try:  # primeira execução: já traz a Selic oficial para a projeção não ficar zerada
                mud = atualizar_selic_bcb(con)
                print(f"Selic obtida do Banco Central: {mud[-1][1]}% a.a.")
            except bcb.ErroBCB as e:
                print(f"Não foi possível obter a Selic agora ({e}). Use Projeção > Atualizar Selic.")
    srv = ThreadingHTTPServer(("127.0.0.1", args.porta), Handler)
    url = f"http://localhost:{args.porta}/"
    print(f"Rendimentos rodando em {url}  (Ctrl+C para encerrar)")
    if not args.sem_navegador:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
