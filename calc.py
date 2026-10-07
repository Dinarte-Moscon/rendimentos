"""Cálculo do consolidado mensal (realizado + projetado) e do rendimento diário.

Regras principais
- O usuário informa o SALDO de cada aplicação em uma data; aportes/resgates são movimentos.
- Rendimento de um período = saldo final - saldo inicial - movimentos do período.
- Entre um saldo informado e a data desejada, o saldo é estimado aplicando a taxa
  da aplicação dia útil a dia útil (base 252), com a Selic vigente em cada dia.
- Meses futuros: (saldo anterior + aporte planejado) x fator do mês.
"""
import calendar
from bisect import bisect_right
from collections import defaultdict
from datetime import date, timedelta


def d(s):
    return date.fromisoformat(s) if isinstance(s, str) else s


def fim_mes(dt):
    return date(dt.year, dt.month, calendar.monthrange(dt.year, dt.month)[1])


def meses(ini, fim):
    a, m = ini.year, ini.month
    while (a, m) <= (fim.year, fim.month):
        yield date(a, m, 1)
        m += 1
        if m > 12:
            a, m = a + 1, 1


class Calendario:
    """Dias úteis com contagem acumulada pré-calculada."""

    def __init__(self, feriados, ini, fim):
        self.ini = ini - timedelta(days=1)
        self.feriados = set(feriados)
        n = (fim - self.ini).days + 2
        self.acum = [0] * n
        total = 0
        for i in range(n):
            dia = self.ini + timedelta(days=i)
            total += 1 if self.util(dia) else 0
            self.acum[i] = total

    def util(self, dia):
        return dia.weekday() < 5 and dia not in self.feriados

    def _idx(self, dia):
        return max(0, min((dia - self.ini).days, len(self.acum) - 1))

    def dias_uteis(self, a, b):
        """Dias úteis no intervalo (a, b]."""
        if b <= a:
            return 0
        return self.acum[self._idx(b)] - self.acum[self._idx(a)]

    def uteis_entre(self, a, b):
        dia = a + timedelta(days=1)
        while dia <= b:
            if self.util(dia):
                yield dia
            dia += timedelta(days=1)


class Motor:
    def __init__(self, con, hoje=None, delta_selic=0.0):
        from db import ler_config
        self.hoje = hoje or date.today()
        self.delta_selic = delta_selic / 100   # deslocamento (p.p.) aplicado à Selic futura, para cenários
        self.cfg = ler_config(con)
        self.inicio = d(self.cfg["data_inicio"]).replace(day=1)
        self.meta = fim_mes(d(self.cfg["data_meta"]))
        self.spread = float(self.cfg.get("spread_cdi") or 0) / 100
        self.ipca = float(self.cfg.get("ipca_projetado") or 0) / 100

        self.apps = [dict(r) for r in con.execute("SELECT * FROM aplicacao ORDER BY ordem, id")]
        self.saldos = defaultdict(list)       # app -> [(data, valor)] ordenado
        for r in con.execute("SELECT aplicacao_id, data, valor FROM saldo ORDER BY data"):
            self.saldos[r[0]].append((d(r[1]), r[2]))
        self.movs = defaultdict(list)         # app -> [(data, valor)] ordenado
        for r in con.execute("SELECT aplicacao_id, data, valor FROM movimento ORDER BY data, id"):
            self.movs[r[0]].append((d(r[1]), r[2]))
        self.planejado = {}                   # (app, 'AAAA-MM') -> valor
        for r in con.execute("SELECT aplicacao_id, mes, valor FROM aporte_planejado"):
            self.planejado[(r[0], r[1])] = r[2]
        sel = [(d(r[0]), r[1] / 100) for r in con.execute("SELECT vigencia, taxa_aa FROM selic ORDER BY vigencia")]
        self.selic_datas = [x[0] for x in sel]
        self.selic_taxas = [x[1] for x in sel] or [0.0]
        feriados = [d(r[0]) for r in con.execute("SELECT data FROM feriado")]
        primeiro = min([self.inicio] + [s[0][0] for s in self.saldos.values() if s]
                       + [m[0][0] for m in self.movs.values() if m])
        self.cal = Calendario(feriados, primeiro - timedelta(days=40), self.meta + timedelta(days=40))
        self._fator_cache = {}

    # ---------- taxas ----------
    def selic_em(self, dia):
        i = bisect_right(self.selic_datas, dia) - 1
        taxa = self.selic_taxas[max(i, 0)]
        if self.delta_selic and dia > self.hoje:
            taxa = max(taxa + self.delta_selic, 0)
        return taxa

    def cdi_em(self, dia):
        return max(self.selic_em(dia) - self.spread, 0)

    def taxa_dia(self, app, dia):
        tipo, taxa = app["tipo"], app["taxa"] / 100
        if tipo in ("CDI", "SELIC"):
            return ((1 + self.cdi_em(dia)) ** (1 / 252) - 1) * taxa
        if tipo == "PRE":
            return (1 + taxa) ** (1 / 252) - 1
        if tipo == "IPCA":
            return ((1 + self.ipca) * (1 + taxa)) ** (1 / 252) - 1
        if tipo == "MENSAL":
            du = self.cal.dias_uteis(dia.replace(day=1) - timedelta(days=1), fim_mes(dia)) or 1
            return (1 + taxa) ** (1 / du) - 1
        return 0.0

    def fator(self, app, a, b):
        """Fator de correção no intervalo (a, b]."""
        if b <= a:
            return 1.0
        chave = (app["id"], a, b)
        if chave not in self._fator_cache:
            f = 1.0
            for dia in self.cal.uteis_entre(a, b):
                f *= 1 + self.taxa_dia(app, dia)
            self._fator_cache[chave] = f
        return self._fator_cache[chave]

    def fator_cdi_mes(self, mes):
        """Rendimento do CDI 100% no mês (para comparação)."""
        f = 1.0
        for dia in self.cal.uteis_entre(mes - timedelta(days=1), fim_mes(mes)):
            f *= (1 + self.cdi_em(dia)) ** (1 / 252)
        return f - 1

    # ---------- saldos ----------
    def ultimo_saldo(self, app_id, dia):
        lst = self.saldos[app_id]
        i = bisect_right([x[0] for x in lst], dia) - 1
        return lst[i] if i >= 0 else None

    def mov_soma(self, app_id, a, b, incl_a=True):
        """Soma dos movimentos em [a, b] (ou (a, b] se incl_a=False)."""
        tot = 0.0
        for dt, v in self.movs[app_id]:
            if (dt >= a if incl_a else dt > a) and dt <= b:
                tot += v
        return tot

    def saldo_em(self, app, dia, extras=()):
        """Saldo na data: último saldo informado + movimentos posteriores, corrigidos pela taxa."""
        ult = self.ultimo_saldo(app["id"], dia)
        base_dt, valor = ult if ult else (None, 0.0)
        movs = [(dt, v) for dt, v in list(self.movs[app["id"]]) + list(extras)
                if (base_dt is None or dt > base_dt) and dt <= dia]
        movs.sort()
        t = base_dt
        for dt, v in movs:
            if t is not None:
                valor *= self.fator(app, t, dt)
            valor += v
            t = dt
        if t is not None and abs(valor) > 0.005:
            valor *= self.fator(app, t, dia)
        return valor

    def saldo_real(self, app_id, dia):
        """Último saldo informado + movimentos posteriores (sem estimar rendimento)."""
        ult = self.ultimo_saldo(app_id, dia)
        base_dt, valor = ult if ult else (None, 0.0)
        for dt, v in self.movs[app_id]:
            if (base_dt is None or dt > base_dt) and dt <= dia:
                valor += v
        return valor

    # ---------- consolidado ----------
    def mensal_app(self, app):
        hoje = self.hoje
        mes_atual = hoje.replace(day=1)
        linhas = []
        anterior = self.saldo_em(app, self.inicio - timedelta(days=1))
        for mes in meses(self.inicio, self.meta):
            fim = fim_mes(mes)
            chave_mes = mes.strftime("%Y-%m")
            lin = {"mes": chave_mes, "anterior": anterior, "parcial": None, "dias_uteis": None}
            if mes < mes_atual:
                aporte = self.mov_soma(app["id"], mes, fim)
                final = self.saldo_em(app, fim)
                lin["status"] = "realizado"
            elif mes == mes_atual:
                aporte_real = self.mov_soma(app["id"], mes, fim)
                plan = self.planejado.get((app["id"], chave_mes), 0.0) if abs(aporte_real) < 0.005 else 0.0
                extras = [(hoje, plan)] if plan else []
                aporte = aporte_real + plan
                final = self.saldo_em(app, fim, extras)
                ult = self.ultimo_saldo(app["id"], hoje)
                if ult and ult[0] >= mes:
                    lin["parcial"] = ult[1] - anterior - self.mov_soma(app["id"], mes, ult[0])
                    lin["parcial_ate"] = ult[0].isoformat()
                    lin["dias_uteis"] = self.cal.dias_uteis(mes - timedelta(days=1), ult[0])
                lin["status"] = "em_andamento"
            else:
                aporte = self.planejado.get((app["id"], chave_mes), 0.0)
                base = anterior + aporte
                final = base * self.fator(app, mes - timedelta(days=1), fim) if abs(base) > 0.005 else base
                lin["status"] = "projetado"
            rend = final - anterior - aporte
            lin.update(aporte=aporte, rendimento=rend, final=final)
            linhas.append(lin)
            anterior = final
        return linhas

    def consolidado(self, app_ids=None):
        sel = [a for a in self.apps if app_ids is None or a["id"] in app_ids]
        por_app = {a["id"]: self.mensal_app(a) for a in sel}
        meses_lst = list(meses(self.inicio, self.meta))
        total = []
        for i, mes in enumerate(meses_lst):
            linhas = [por_app[a["id"]][i] for a in sel]
            t = {"mes": mes.strftime("%Y-%m"), "status": linhas[0]["status"] if linhas else "projetado"}
            for k in ("anterior", "aporte", "rendimento", "final"):
                t[k] = sum(l[k] for l in linhas)
            parciais = [l for l in linhas if l["parcial"] is not None]
            if parciais:
                t["parcial"] = sum(l["parcial"] for l in parciais)
                t["parcial_ate"] = max(l["parcial_ate"] for l in parciais)
                t["dias_uteis"] = self.cal.dias_uteis(mes - timedelta(days=1), d(t["parcial_ate"]))
            else:
                t["parcial"], t["parcial_ate"], t["dias_uteis"] = None, None, None
            base = t["anterior"] + t["aporte"]
            t["percentual"] = t["rendimento"] / base if abs(base) > 0.005 else None
            t["cdi_mes"] = self.fator_cdi_mes(mes)
            t["por_app"] = {a["id"]: round(linhas[j]["final"], 2) for j, a in enumerate(sel)}
            t["rend_app"] = {a["id"]: round(linhas[j]["rendimento"], 2) for j, a in enumerate(sel)}
            total.append(t)
        return sel, total

    def rendimento_diario(self, app_ids=None, desde=None, ate=None):
        """Rendimento por lançamento de saldo: saldo - saldo anterior - movimentos entre eles."""
        res = []
        for app in self.apps:
            if app_ids is not None and app["id"] not in app_ids:
                continue
            anterior = None
            for dt, valor in self.saldos[app["id"]]:
                if anterior is not None:
                    mov = self.mov_soma(app["id"], anterior[0], dt, incl_a=False)
                    rend = valor - anterior[1] - mov
                    du = self.cal.dias_uteis(anterior[0], dt)
                    if (desde is None or dt >= desde) and (ate is None or dt <= ate):
                        res.append({"aplicacao_id": app["id"], "data": dt.isoformat(), "saldo": valor,
                                    "saldo_anterior": anterior[1], "data_anterior": anterior[0].isoformat(),
                                    "movimento": mov, "rendimento": rend, "dias_uteis": du})
                anterior = (dt, valor)
        return res
