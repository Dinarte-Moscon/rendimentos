"""Acesso ao banco SQLite: criação do esquema, feriados e configuração padrão."""
import os
import sqlite3
from datetime import date, timedelta

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# RENDIMENTOS_DB permite apontar para outro arquivo (ex.: um banco de demonstração)
DB_PATH = os.environ.get("RENDIMENTOS_DB") or os.path.join(BASE_DIR, "dados", "rendimentos.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS aplicacao (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    nome            TEXT    NOT NULL,
    instituicao     TEXT,
    tipo            TEXT    NOT NULL,            -- CDI | SELIC | PRE | IPCA | MENSAL
    taxa            REAL    NOT NULL DEFAULT 100, -- CDI/SELIC: % do indexador; PRE: % a.a.; IPCA: spread % a.a.; MENSAL: % a.m.
    ativa           INTEGER NOT NULL DEFAULT 1,
    data_encerramento TEXT,
    ordem           INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS saldo (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    aplicacao_id INTEGER NOT NULL REFERENCES aplicacao(id) ON DELETE CASCADE,
    data         TEXT    NOT NULL,
    valor        REAL    NOT NULL,
    UNIQUE (aplicacao_id, data)
);
CREATE TABLE IF NOT EXISTS movimento (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    aplicacao_id INTEGER NOT NULL REFERENCES aplicacao(id) ON DELETE CASCADE,
    data         TEXT    NOT NULL,
    valor        REAL    NOT NULL,              -- positivo = aporte, negativo = resgate
    descricao    TEXT
);
CREATE TABLE IF NOT EXISTS aporte_planejado (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    aplicacao_id INTEGER NOT NULL REFERENCES aplicacao(id) ON DELETE CASCADE,
    mes          TEXT    NOT NULL,              -- AAAA-MM
    valor        REAL    NOT NULL,
    UNIQUE (aplicacao_id, mes)
);
CREATE TABLE IF NOT EXISTS selic (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    vigencia TEXT NOT NULL UNIQUE,              -- a partir desta data
    taxa_aa  REAL NOT NULL,                     -- meta Selic em % a.a.
    origem   TEXT NOT NULL DEFAULT 'manual'     -- manual | bcb | focus
);
CREATE TABLE IF NOT EXISTS feriado (
    data      TEXT PRIMARY KEY,
    descricao TEXT
);
CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT
);
CREATE INDEX IF NOT EXISTS ix_saldo_data ON saldo(data);
CREATE INDEX IF NOT EXISTS ix_mov_app_data ON movimento(aplicacao_id, data);
"""

def config_padrao():
    """Valores iniciais de um banco novo: acompanha a partir do mês atual, com meta em 5 anos."""
    hoje = date.today()
    return {
        "data_inicio": hoje.replace(day=1).isoformat(),        # primeiro mês exibido no consolidado
        "data_meta": date(hoje.year + 5, 12, 31).isoformat(),  # fim do horizonte de projeção
        "spread_cdi": "0.10",          # CDI = meta Selic - spread (p.p.)
        "ipca_projetado": "4.0",       # % a.a. usado nas aplicações IPCA+
        "cenario_variacao": "1.0",     # faixa de cenários do painel: Selic futura ± este valor (p.p.)
        "focus_ultima_busca": "",
    }


def pascoa(ano):
    """Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher)."""
    a = ano % 19
    b, c = divmod(ano, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    mes = (h + l - 7 * m + 114) // 31
    dia = ((h + l - 7 * m + 114) % 31) + 1
    return date(ano, mes, dia)


def feriados_nacionais(ano):
    """Feriados bancários nacionais (calendário ANBIMA)."""
    p = pascoa(ano)
    lista = [
        (date(ano, 1, 1), "Confraternização Universal"),
        (p - timedelta(days=48), "Carnaval"),
        (p - timedelta(days=47), "Carnaval"),
        (p - timedelta(days=2), "Paixão de Cristo"),
        (date(ano, 4, 21), "Tiradentes"),
        (date(ano, 5, 1), "Dia do Trabalho"),
        (p + timedelta(days=60), "Corpus Christi"),
        (date(ano, 9, 7), "Independência do Brasil"),
        (date(ano, 10, 12), "Nossa Senhora Aparecida"),
        (date(ano, 11, 2), "Finados"),
        (date(ano, 11, 15), "Proclamação da República"),
        (date(ano, 12, 25), "Natal"),
    ]
    if ano >= 2024:
        lista.append((date(ano, 11, 20), "Dia Nacional de Zumbi e da Consciência Negra"))
    return lista


def conectar():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def inicializar():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with conectar() as con:
        con.executescript(SCHEMA)
        for chave, valor in config_padrao().items():
            con.execute("INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)", (chave, valor))
        if con.execute("SELECT COUNT(*) FROM feriado").fetchone()[0] == 0:
            for ano in range(2024, max(2041, date.today().year + 16)):
                for d, desc in feriados_nacionais(ano):
                    con.execute("INSERT OR IGNORE INTO feriado (data, descricao) VALUES (?, ?)",
                                (d.isoformat(), desc))


def ler_config(con):
    return {r["chave"]: r["valor"] for r in con.execute("SELECT chave, valor FROM config")}
