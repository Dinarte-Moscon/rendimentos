"""Consulta da Selic no Banco Central (SGS 432) e das expectativas do boletim Focus."""
import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta

SGS_SELIC_META = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados"
FOCUS_ANUAIS = "https://olinda.bcb.gov.br/olinda/servico/Expectativas/versao/v1/odata/ExpectativasMercadoAnuais"


class ErroBCB(Exception):
    pass


def _get_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "Rendimentos/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            texto = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        raise ErroBCB(f"O serviço do Banco Central respondeu com erro {e.code}. Tente novamente mais tarde.")
    except Exception as e:  # rede, tempo esgotado etc.
        raise ErroBCB(f"Falha ao consultar o Banco Central: {e}")
    texto = texto.strip()
    if texto.startswith("/*"):  # o Olinda devolve erros dentro de comentário
        raise ErroBCB("Serviço do Banco Central indisponível no momento: " + texto.strip("/*").strip())
    try:
        return json.loads(texto)
    except ValueError:
        raise ErroBCB("Resposta inválida do Banco Central.")


def historico_selic(desde, ate=None):
    """Mudanças da meta Selic entre as datas: [(data, taxa_aa)]. A série publica dias futuros, por isso o corte em 'ate'."""
    ate = ate or date.today()
    url = f"{SGS_SELIC_META}?formato=json&dataInicial={desde:%d/%m/%Y}&dataFinal={ate:%d/%m/%Y}"
    dados = _get_json(url)
    mudancas, anterior = [], None
    for r in dados:
        dia, mes, ano = r["data"].split("/")
        dt = date(int(ano), int(mes), int(dia))
        taxa = float(r["valor"])
        if dt > ate:
            break
        if taxa != anterior:
            mudancas.append((dt, taxa))
            anterior = taxa
    if not mudancas:
        raise ErroBCB("O Banco Central não retornou valores da Selic para o período.")
    return mudancas


def focus_selic_anual():
    """Mediana da Selic de fim de ano no Focus mais recente: (data_focus, {ano: taxa})."""
    filtro = "Indicador eq 'Selic' and baseCalculo eq 0"
    params = {"$top": "20", "$filter": filtro, "$orderby": "Data desc", "$format": "json",
              "$select": "Data,DataReferencia,Mediana"}
    url = FOCUS_ANUAIS + "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    dados = _get_json(url).get("value", [])
    if not dados:
        raise ErroBCB("O Focus não retornou expectativas para a Selic.")
    ultima = max(r["Data"] for r in dados)
    anos = {int(r["DataReferencia"]): float(r["Mediana"]) for r in dados if r["Data"] == ultima}
    return ultima, dict(sorted(anos.items()))


def curva_focus(atual, hoje, anos, ate):
    """Curva mensal da Selic: parte da taxa atual e interpola até a mediana de fim de cada ano.

    Retorna [(primeiro dia do mês, taxa)] do próximo mês até 'ate'. Depois do último ano do
    Focus a taxa fica constante.
    """
    pontos = [(hoje, atual)] + [(date(a, 12, 31), t) for a, t in anos.items() if date(a, 12, 31) > hoje]
    curva = []
    a, m = hoje.year, hoje.month + 1
    if m > 12:
        a, m = a + 1, 1
    while date(a, m, 1) <= ate:
        dt = date(a, m, 1)
        taxa = pontos[-1][1]
        for (d0, t0), (d1, t1) in zip(pontos, pontos[1:]):
            if d0 <= dt <= d1:
                taxa = t0 + (t1 - t0) * (dt - d0).days / (d1 - d0).days
                break
        curva.append((dt, round(taxa * 4) / 4))  # Copom decide em múltiplos de 0,25
        m += 1
        if m > 12:
            a, m = a + 1, 1
    # mantém apenas os meses em que a taxa muda
    resumida, anterior = [], atual
    for dt, t in curva:
        if t != anterior:
            resumida.append((dt, t))
            anterior = t
    return resumida
