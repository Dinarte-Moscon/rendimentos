"use strict";

// ------------------------------------------------------------------ utilitários
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const TIPOS = { CDI: "% do CDI", SELIC: "% da Selic", PRE: "% a.a. pré", IPCA: "IPCA + % a.a.", MENSAL: "% a.m." };
const TITULOS = { painel: "Painel", lancamento: "Lançamento diário", movimentos: "Aportes e resgates", projecao: "Projeção", aplicacoes: "Aplicações", config: "Configurações", ajuda: "Como usar" };

const brl = (v, dec = 2) => v == null ? "–" :
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: dec, maximumFractionDigits: dec });
const numBR = (v, dec = 2) => v == null ? "" : v.toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
const pct = (v, dec = 2) => v == null || !Number.isFinite(v) ? "–" : (v * 100).toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec }) + "%";
const dataBR = s => s ? s.slice(8, 10) + "/" + s.slice(5, 7) + "/" + s.slice(0, 4) : "–";
const diaMes = s => s ? s.slice(8, 10) + "/" + s.slice(5, 7) : "–";
const mesBR = s => MESES[+s.slice(5, 7) - 1] + "/" + s.slice(2, 4);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hojeISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const somaDias = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const classeSinal = v => v > 0.005 ? "pos" : v < -0.005 ? "neg" : "";
const abreviar = v => Math.abs(v) >= 1e6 ? (v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " mi"
  : Math.abs(v) >= 1000 ? (v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mil" : v.toLocaleString("pt-BR");
const brlCurto = v => v == null ? "–" : Math.abs(v) >= 1000 ? "R$ " + abreviar(v) : brl(v);
const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* sem armazenamento */ } };
const ler = (k, padrao) => { try { return localStorage.getItem(k) ?? padrao; } catch (e) { return padrao; } };

function parseNum(s) {
  if (s == null) return null;
  s = String(s).trim().replace(/\s|R\$/g, "");
  if (s === "") return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

function pilula(v, texto) {
  const cls = v > 0.005 ? "pos" : v < -0.005 ? "neg" : "";
  const seta = v > 0.005 ? "▲" : v < -0.005 ? "▼" : "■";
  return `<span class="pilula ${cls}">${seta} ${texto}</span>`;
}

function toast(msg, erro = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "visivel" + (erro ? " erro" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.className = "", erro ? 6000 : 2500);
}

async function api(metodo, url, corpo) {
  const r = await fetch(url, {
    method: metodo,
    headers: corpo ? { "Content-Type": "application/json" } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    toast(dados.erro || `Erro ${r.status}`, true);
    throw new Error(dados.erro);
  }
  return dados;
}

const cp = (form, n) => $(`[name="${n}"]`, form);
const formDados = form => Object.fromEntries($$("[name]", form).map(el =>
  [el.name, el.type === "checkbox" ? el.checked : el.value]));
function preencher(form, obj) {
  $$("[name]", form).forEach(el => {
    const v = obj[el.name];
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v ?? "";
  });
}

// ------------------------------------------------------------------ aparência (tema + modo)
const mqEscuro = window.matchMedia("(prefers-color-scheme: dark)");
function aplicarAparencia() {
  const paleta = $("#paleta").value, modo = $("#modo").value;
  guardar("paleta", paleta); guardar("modo", modo);
  document.documentElement.dataset.paleta = paleta;
  document.documentElement.dataset.modo = (modo ? modo === "dark" : mqEscuro.matches) ? "dark" : "light";
  redesenhar();
}
function redesenhar() {
  const aba = $("section.aba.ativa")?.id.replace("aba-", "");
  if (aba === "painel" && painel) desenharPainel();
  if (aba === "projecao") carregarProjecao();
  if (aba === "aplicacoes") carregarApps();
}

const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function cores() {
  const c = {};
  for (const [k, v] of Object.entries({
    s1: "--s1", s1soft: "--s1-soft", s2: "--s2", grid: "--grid", texto: "--text-secondary", muted: "--text-muted",
    surface: "--surface-1", primario: "--text-primary", good: "--good", critical: "--critical", accent: "--accent", fonteNum: "--font-num",
  })) c[k] = cssVar(v);
  c.cat = [1, 2, 3, 4, 5, 6, 7, 8].map(i => cssVar("--cat-" + i));
  return c;
}
function alfa(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map(x => x + x).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// ------------------------------------------------------------------ gráficos
const graficos = {};
function grafico(id, config) {
  graficos[id]?.destroy();
  const el = document.getElementById(id);
  if (el) graficos[id] = new Chart(el, config);
}

// linha vertical "hoje"
const linhaHoje = {
  id: "linhaHoje",
  afterDatasetsDraw(chart, args, opts) {
    if (opts.indice == null || opts.indice < 0) return;
    const { ctx, chartArea: a, scales: { x } } = chart;
    const px = x.getPixelForValue(opts.indice);
    if (px < a.left || px > a.right) return;
    ctx.save();
    ctx.strokeStyle = opts.cor; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(px, a.top + 14); ctx.lineTo(px, a.bottom); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = opts.cor; ctx.font = "600 11px " + Chart.defaults.font.family;
    ctx.textAlign = "center"; ctx.fillText("hoje", px, a.top + 9);
    ctx.restore();
  },
};

function tooltipBase(c) {
  return {
    backgroundColor: c.surface, titleColor: c.primario, bodyColor: c.texto,
    borderColor: c.grid, borderWidth: 1, padding: 10, boxPadding: 4, usePointStyle: true,
    titleFont: { weight: "600" }, bodyFont: { family: c.fonteNum },
  };
}
function mesclar(a, b) {
  const r = { ...a };
  for (const [k, v] of Object.entries(b)) {
    r[k] = v && typeof v === "object" && !Array.isArray(v) && typeof a[k] === "object" && a[k] && !Array.isArray(a[k])
      ? mesclar(a[k], v) : v;
  }
  return r;
}
function opcoesBase(c, extra = {}) {
  const base = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false }, tooltip: tooltipBase(c) },
    scales: {
      x: { grid: { display: false }, ticks: { color: c.muted, maxRotation: 0, autoSkipPadding: 14 }, border: { color: c.grid } },
      y: { grid: { color: c.grid }, border: { display: false }, ticks: { color: c.muted, callback: v => abreviar(v) } },
    },
  };
  return mesclar(base, extra);
}
function gradiente(cor, topo = .22) {
  return ctx => {
    const { chart } = ctx, a = chart.chartArea;
    if (!a) return alfa(cor, topo / 2);
    const g = chart.ctx.createLinearGradient(0, a.top, 0, a.bottom);
    g.addColorStop(0, alfa(cor, topo)); g.addColorStop(1, alfa(cor, 0));
    return g;
  };
}
function sparkline(id, tipo, valores, rotulos, cor, corBarras) {
  const c = cores();
  grafico(id, {
    type: tipo,
    data: {
      labels: rotulos, datasets: [{
        data: valores, borderColor: cor, backgroundColor: tipo === "line" ? gradiente(cor, .25) : (corBarras || cor),
        fill: tipo === "line" ? "start" : false, borderWidth: tipo === "line" ? 2 : 0, pointRadius: 0, pointHoverRadius: 4,
        tension: .3, borderRadius: 2, barPercentage: .7,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { ...tooltipBase(c), padding: 6, displayColors: false, callbacks: { label: it => brl(it.parsed.y) } } },
      scales: { x: { display: false }, y: { display: false, beginAtZero: tipo === "bar" } },
    },
  });
}

// ------------------------------------------------------------------ estado
let aplicacoes = [];
let painel = null;
let periodo = ler("periodo", "tudo");
const anosAbertos = new Set();

const corApp = (id, c) => {
  const i = aplicacoes.findIndex(a => a.id === id);
  return i >= 0 && i < 8 ? c.cat[i] : c.muted;
};

async function carregarAplicacoes() {
  aplicacoes = await api("GET", "/api/aplicacoes");
  const opts = lst => lst.map(a => `<option value="${a.id}">${esc(a.nome)}</option>`).join("");
  $$(".sel-app").forEach(s => s.innerHTML = opts(aplicacoes));
  $$(".sel-app-ativa").forEach(s => s.innerHTML = opts(aplicacoes.filter(a => a.ativa)));
  const f = $("#filtro-app"), atual = f.value;
  f.innerHTML = `<option value="todas">Todas</option>` + opts(aplicacoes);
  f.value = [...f.options].some(o => o.value === atual) ? atual : "todas";
  const mf = $("#mov-filtro"), mAtual = mf.value;
  mf.innerHTML = `<option value="">Todas as aplicações</option>` + opts(aplicacoes);
  mf.value = mAtual;
}

async function carregarResumo() {
  try {
    const r = await api("GET", "/api/resumo");
    $("#chips").innerHTML =
      `<span class="chip">Patrimônio <b>${brl(r.patrimonio)}</b></span>` +
      (r.mes_parcial != null ? `<span class="chip">Mês <b>${brl(r.mes_parcial)}</b> até ${diaMes(r.mes_parcial_ate)}</span>` : "") +
      `<span class="chip">Selic <b>${numBR(r.selic_atual)}%</b></span>`;
  } catch (e) { /* toast já exibido */ }
}

// ------------------------------------------------------------------ abas
const carregadores = {
  painel: carregarPainel, lancamento: carregarLancamento, movimentos: carregarMovimentos,
  projecao: carregarProjecao, aplicacoes: carregarApps, config: carregarConfig, ajuda: () => {},
};
function abrirAba(nome) {
  $$("nav.abas button").forEach(b => b.classList.toggle("ativa", b.dataset.aba === nome));
  $$("section.aba").forEach(s => s.classList.toggle("ativa", s.id === "aba-" + nome));
  $("#titulo").textContent = TITULOS[nome];
  document.title = TITULOS[nome] + " · Rendimentos";
  guardar("aba", nome);
  carregadores[nome]();
}

// ------------------------------------------------------------------ PAINEL
async function carregarPainel() {
  painel = await api("GET", "/api/dashboard?aplicacao=" + $("#filtro-app").value);
  desenharPainel();
}

function faixaPeriodo(meses, hoje) {
  const iAtual = Math.max(0, meses.findIndex(m => m.mes === hoje.slice(0, 7)));
  const ano = hoje.slice(0, 4);
  switch (periodo) {
    case "12m": return [Math.max(0, iAtual - 11), iAtual];
    case "ano": {
      const ini = meses.findIndex(m => m.mes.startsWith(ano));
      const fim = meses.map(m => m.mes.slice(0, 4)).lastIndexOf(ano);
      return [Math.max(ini, 0), fim < 0 ? meses.length - 1 : fim];
    }
    case "meta": return [Math.max(0, iAtual - 1), meses.length - 1];
    default: return [0, meses.length - 1];
  }
}

function desenharPainel() {
  const p = painel, k = p.kpis, c = cores();
  const vazio = !aplicacoes.length;   // primeira execução: mostra os primeiros passos no lugar dos gráficos
  $("#boas-vindas").hidden = !vazio;
  $$("#aba-painel > .filtros, #aba-painel > .kpis, #aba-painel > .grade, #aba-painel > .cartao:not(#boas-vindas)").forEach(el => el.hidden = vazio);
  if (vazio) { $("#aviso-selic").hidden = true; return; }
  $$("#periodo button").forEach(b => b.classList.toggle("ativo", b.dataset.periodo === periodo));
  $("#aviso-selic").hidden = k.selic_atual > 0;
  desenharKpis(p, k, c);

  const meses = p.meses;
  const iAtual = meses.findIndex(m => m.mes === p.hoje.slice(0, 7));
  const iUltReal = meses.map(m => m.status).lastIndexOf("realizado");
  const [i0, i1] = faixaPeriodo(meses, p.hoje);
  const corte = arr => arr.slice(i0, i1 + 1);
  const labels = corte(meses.map(m => mesBR(m.mes)));
  const idxHoje = iAtual >= i0 && iAtual <= i1 ? iAtual - i0 : null;

  // ---- Patrimônio
  let aportado = meses.length ? meses[0].anterior : 0;
  const acumAportes = meses.map(m => (aportado += m.aporte));
  const realizado = meses.map((m, i) => i <= iUltReal ? m.final : null);
  const projetado = meses.map((m, i) => i >= iUltReal ? m.final : null);
  const temCenario = !!(p.cenarios.baixo && p.cenarios.alto);
  const cenBaixo = meses.map((m, i) => temCenario && i >= iUltReal ? (i === iUltReal ? m.final : p.cenarios.baixo[i]) : null);
  const cenAlto = meses.map((m, i) => temCenario && i >= iUltReal ? (i === iUltReal ? m.final : p.cenarios.alto[i]) : null);
  // marca resgates e aportes grandes (acima do dobro da mediana dos aportes realizados)
  const aportesReais = meses.filter(m => m.status !== "projetado" && m.aporte > 0).map(m => m.aporte).sort((a, b) => a - b);
  const mediana = aportesReais.length ? aportesReais[Math.floor(aportesReais.length / 2)] : 0;
  const relevante = (m, i) => i <= iAtual && m.status !== "projetado" &&
    (m.aporte < 0 ? -m.aporte >= Math.abs(m.anterior) * .02 : m.aporte >= Math.max(mediana * 2, 1000));
  const marcadores = meses.map((m, i) => relevante(m, i) ? m.final : null);
  const rotacao = meses.map(m => m.aporte < 0 ? 180 : 0);
  const corMarc = meses.map(m => m.aporte < 0 ? c.critical : c.good);

  $("#leg-patrimonio").innerHTML =
    `<span style="--cor: var(--s1)">Realizado</span>` +
    `<span class="tracejado" style="--cor: var(--s1)">Projetado</span>` +
    (temCenario ? `<span class="faixa" style="--cor: var(--s1)">Selic futura ± ${numBR(k.cenario_variacao, 1)} p.p.</span>` : "") +
    `<span style="--cor: var(--s2)">Total aportado</span>` +
    `<span class="sem"><b class="tri-up">▲</b>&nbsp;aporte&nbsp;<b class="tri-down">▼</b>&nbsp;resgate relevantes</span>`;

  const ponto = { pointRadius: 0, pointHoverRadius: 5, pointHoverBorderColor: c.surface, pointHoverBorderWidth: 2 };
  const ordemTooltip = [2, 3, 1, 0, 4, 5];
  grafico("g-patrimonio", {
    type: "line",
    data: {
      labels, datasets: [
        { label: "Selic menor", data: corte(cenBaixo), borderColor: "transparent", backgroundColor: "transparent", pointRadius: 0, pointHoverRadius: 0, fill: false },
        { label: "Selic maior", data: corte(cenAlto), borderColor: "transparent", backgroundColor: alfa(c.s1, .13), pointRadius: 0, pointHoverRadius: 0, fill: "-1" },
        { label: "Realizado", data: corte(realizado), borderColor: c.s1, backgroundColor: gradiente(c.s1, .20), borderWidth: 2, fill: "start", ...ponto },
        { label: "Projetado", data: corte(projetado), borderColor: c.s1, backgroundColor: c.s1, borderWidth: 2, borderDash: [6, 4], ...ponto },
        { label: "Total aportado", data: corte(acumAportes), borderColor: c.s2, backgroundColor: c.s2, borderWidth: 2, ...ponto },
        {
          label: "Movimento", data: corte(marcadores), showLine: false, pointStyle: "triangle",
          pointRotation: corte(rotacao), pointBackgroundColor: corte(corMarc), pointBorderColor: c.surface, pointBorderWidth: 2,
          pointRadius: 7, pointHoverRadius: 8,
        },
      ],
    },
    options: opcoesBase(c, {
      plugins: {
        linhaHoje: { indice: idxHoje, cor: c.muted },
        tooltip: {
          filter: it => it.raw != null && !([0, 1, 3].includes(it.datasetIndex) && it.dataIndex + i0 === iUltReal),
          itemSort: (a, b) => ordemTooltip.indexOf(a.datasetIndex) - ordemTooltip.indexOf(b.datasetIndex),
          callbacks: {
            label: it => {
              if (it.datasetIndex === 5) {
                const m = meses[it.dataIndex + i0];
                return ` ${m.aporte < 0 ? "Resgate" : "Aporte"} no mês: ${brl(m.aporte)}`;
              }
              return ` ${it.dataset.label}: ${brl(it.parsed.y)}`;
            },
          },
        },
      },
    }),
    plugins: [linhaHoje],
  });

  // ---- Rendimento mensal (empilhado: realizado + restante projetado) com referência do CDI
  const real = meses.map(m => m.status === "realizado" ? m.rendimento : m.status === "em_andamento" ? (m.parcial ?? 0) : null);
  const proj = meses.map(m => m.status === "projetado" ? m.rendimento : m.status === "em_andamento" ? m.rendimento - (m.parcial ?? 0) : null);
  const cdi = meses.map(m => { const base = m.anterior + m.aporte; return base > 0 && m.cdi_mes ? base * m.cdi_mes : null; });
  grafico("g-mensal", {
    type: "bar",
    data: {
      labels, datasets: [
        { type: "line", label: "CDI 100%", data: corte(cdi), borderColor: c.muted, borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0, pointHoverRadius: 3, order: 0 },
        { label: "Realizado", data: corte(real), backgroundColor: c.s1, borderRadius: 3, borderSkipped: "bottom", stack: "r", order: 1 },
        { label: "Projetado", data: corte(proj), backgroundColor: c.s1soft, borderRadius: 3, borderSkipped: "bottom", stack: "r", order: 1 },
      ],
    },
    options: opcoesBase(c, {
      plugins: {
        linhaHoje: { indice: idxHoje, cor: c.muted },
        tooltip: {
          filter: it => it.raw != null,
          callbacks: {
            label: it => {
              const m = meses[it.dataIndex + i0];
              if (it.datasetIndex === 0) return ` CDI 100%: ${brl(it.parsed.y)} (rendeu ${pct(m.rendimento / it.parsed.y, 0)} do CDI)`;
              if (m.status === "em_andamento") return it.datasetIndex === 1 ? ` Realizado até agora: ${brl(m.parcial)}` : ` Projeção do mês: ${brl(m.rendimento)}`;
              return ` ${it.dataset.label}: ${brl(it.parsed.y)}`;
            },
          },
        },
      },
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
    }),
    plugins: [linhaHoje],
  });

  // ---- Rendimento por lançamento no mês
  const d = p.diario;
  const totalMes = d.reduce((s, x) => s + x.rendimento, 0);
  const du = d.reduce((s, x) => s + x.dias_uteis, 0);
  $("#t-diario").textContent = `Rendimento por lançamento · ${mesBR(p.hoje)}`;
  $("#leg-diario").innerHTML = d.length
    ? `<span class="sem">${brl(totalMes)} em ${du} dia(s) útil(eis) ·&nbsp;<b>${brl(du ? totalMes / du : null)}</b>/dia útil</span>`
    : `<span class="sem muted">Nenhum saldo lançado neste mês.</span>`;
  grafico("g-diario", {
    type: "bar",
    data: { labels: d.map(x => diaMes(x.data)), datasets: [{ label: "Rendimento", data: d.map(x => x.rendimento), backgroundColor: c.s1, borderRadius: 4, maxBarThickness: 40 }] },
    options: opcoesBase(c, {
      plugins: {
        tooltip: {
          callbacks: { label: it => { const x = d[it.dataIndex]; return [` Rendimento: ${brl(x.rendimento)}`, ` ${x.dias_uteis} dia(s) útil(eis) · ${brl(x.dias_uteis ? x.rendimento / x.dias_uteis : null)}/dia`]; } },
        },
      },
      scales: { y: { beginAtZero: true } },
    }),
  });

  desenharDistribuicao(p, c);
  desenharConsolidado();
}

function desenharKpis(p, k, c) {
  const meses = p.meses;
  const iAtual = meses.findIndex(m => m.mes === p.hoje.slice(0, 7));
  const ult12 = meses.slice(Math.max(0, iAtual - 11), iAtual + 1);
  const delta = k.mes_anterior_final != null ? k.patrimonio - k.mes_anterior_final : null;
  const media = k.mes_parcial != null && k.mes_dias_uteis ? k.mes_parcial / k.mes_dias_uteis : null;
  const ritmo = media != null ? media * k.mes_dias_uteis_total : null;
  const vsAnt = k.mes_anterior_rendimento ? k.mes_projetado / k.mes_anterior_rendimento - 1 : null;
  const ul = k.ultimo_lancamento;
  const progMeta = k.meta_final ? Math.min(1, Math.max(0, k.patrimonio / k.meta_final)) : 0;
  const progMes = k.mes_dias_uteis_total ? Math.min(1, (k.mes_dias_uteis || 0) / k.mes_dias_uteis_total) : 0;
  const mesAnt = k.mes_anterior ? MESES[+k.mes_anterior.slice(5) - 1] : "";

  $("#kpis").innerHTML = `
    <div class="kpi"><div class="rotulo">Patrimônio</div><div class="valor">${brl(k.patrimonio)}</div>
      <div class="detalhe">${delta != null && k.mes_anterior_final ? pilula(delta, `${brlCurto(Math.abs(delta))} · ${pct(Math.abs(delta / k.mes_anterior_final), 2)}`) + ` desde ${mesAnt}` : ""}</div>
      <div class="spark"><canvas id="sp-patrimonio" aria-label="Patrimônio nos últimos 12 meses"></canvas></div></div>
    <div class="kpi"><div class="rotulo">Último lançamento</div><div class="valor">${ul ? brl(ul.rendimento) : "–"}</div>
      <div class="detalhe">${ul ? `em ${diaMes(ul.data)} · ${ul.dias_uteis} dia(s) útil(eis)<br>` + pilula(ul.rendimento, `${brl(ul.dias_uteis ? ul.rendimento / ul.dias_uteis : null)}/dia útil`) : "nenhum lançamento recente"}</div></div>
    <div class="kpi"><div class="rotulo">Mês até agora</div><div class="valor">${brl(k.mes_parcial)}</div>
      <div class="detalhe">${media != null ? `média <b class="num">${brl(media)}</b> por dia útil` : "nenhum saldo lançado neste mês"}</div>
      <div class="progresso"><div class="trilho"><div class="cheio" style="width:${(progMes * 100).toFixed(1)}%"></div></div>
        <div class="rot-prog"><span>${k.mes_dias_uteis || 0} de ${k.mes_dias_uteis_total} dias úteis</span><span>${pct(progMes, 0)}</span></div></div></div>
    <div class="kpi"><div class="rotulo">Projeção do mês</div><div class="valor">${brl(k.mes_projetado)}</div>
      <div class="detalhe">${vsAnt != null ? pilula(vsAnt, pct(Math.abs(vsAnt), 1)) + ` vs ${mesAnt}` : ""}${ritmo != null ? `<br>no ritmo atual: ${brl(ritmo)}` : ""}</div>
      <div class="spark"><canvas id="sp-rendimento" aria-label="Rendimento mensal nos últimos 12 meses"></canvas></div></div>
    <div class="kpi"><div class="rotulo">Meta · ${k.meta_data ? mesBR(k.meta_data) : "–"}</div><div class="valor">${brl(k.meta_final, 0)}</div>
      <div class="detalhe">rendendo ${brl(k.meta_rendimento)} no mês</div>
      <div class="progresso"><div class="trilho"><div class="cheio" style="width:${(progMeta * 100).toFixed(1)}%"></div></div>
        <div class="rot-prog"><span>patrimônio atual</span><span>${pct(progMeta, 1)} da meta</span></div></div></div>`;

  sparkline("sp-patrimonio", "line", ult12.map((m, i) => i === ult12.length - 1 ? k.patrimonio : m.final), ult12.map(m => mesBR(m.mes)), c.s1);
  sparkline("sp-rendimento", "bar", ult12.map(m => m.rendimento),
    ult12.map(m => mesBR(m.mes) + (m.status === "em_andamento" ? " (projeção)" : "")), c.s1,
    ult12.map(m => m.status === "em_andamento" ? c.s1 : c.s1soft));
}

function desenharDistribuicao(p, c) {
  const dist = p.distribuicao.slice().sort((a, b) => b.saldo - a.saldo);
  const tot = dist.reduce((s, x) => s + x.saldo, 0);
  grafico("g-distrib", {
    type: "bar",
    data: {
      labels: ["Distribuição"],
      datasets: dist.map(x => ({
        label: x.nome, data: [tot ? x.saldo / tot * 100 : 0], backgroundColor: corApp(x.id, c),
        borderColor: c.surface, borderWidth: { right: 2, left: 0, top: 0, bottom: 0 }, borderSkipped: false, borderRadius: 5, barThickness: 30,
      })),
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: "nearest", intersect: true },
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipBase(c), callbacks: { title: () => "", label: it => ` ${it.dataset.label}: ${brl(dist[it.datasetIndex].saldo)} (${numBR(it.parsed.x, 1)}%)` } },
      },
      scales: { x: { stacked: true, display: false, max: 100 }, y: { stacked: true, display: false } },
    },
  });
  $("#dist-total").textContent = brl(tot);
  $("#t-distrib").innerHTML = dist.map(x => `<div class="item"><span class="amostra" style="background:${corApp(x.id, c)}"></span>
    <span>${esc(x.nome)}</span><span class="num">${brl(x.saldo)}</span><span class="pct">${pct(tot ? x.saldo / tot : null, 1)}</span></div>`).join("");
}

function desenharConsolidado() {
  if (!painel) return;
  const so = $("#so-realizado").checked;
  const rot = { realizado: "realizado", em_andamento: "em andamento", projetado: "projetado" };
  if (!anosAbertos.size) anosAbertos.add(painel.hoje.slice(0, 4));
  const porAno = {};
  painel.meses.filter(m => !so || m.status !== "projetado").forEach(m => (porAno[m.mes.slice(0, 4)] ??= []).push(m));

  const cab = `<thead><tr><th>Mês</th><th>Situação</th><th class="n">Anterior</th><th class="n">Aporte</th>
    <th class="n">Rendimento</th><th class="n">% mês</th><th class="n" title="Rendimento do mês comparado ao CDI do período">% CDI</th><th class="n">Final</th></tr></thead>`;
  const corpos = Object.entries(porAno).map(([ano, ms]) => {
    const aporte = ms.reduce((s, m) => s + m.aporte, 0), rend = ms.reduce((s, m) => s + m.rendimento, 0);
    const cont = st => ms.filter(m => m.status === st).length;
    const resumo = [cont("realizado") && `${cont("realizado")} realiz.`, cont("em_andamento") && "1 em andamento", cont("projetado") && `${cont("projetado")} proj.`].filter(Boolean).join(" · ");
    const linhas = ms.map(m => {
      const pcdi = m.percentual != null && m.cdi_mes ? m.percentual / m.cdi_mes : null;
      const extra = m.status === "em_andamento" && m.parcial != null ? `<span class="sub">${brl(m.parcial)} até ${diaMes(m.parcial_ate)}</span>` : "";
      return `<tr class="mes ${m.status}">
        <td>${mesBR(m.mes)}</td><td><span class="sit ${m.status}">${rot[m.status]}</span></td>
        <td class="n">${brl(m.anterior)}</td><td class="n ${classeSinal(m.aporte)}">${Math.abs(m.aporte) > .005 ? brl(m.aporte) : "–"}</td>
        <td class="n">${brl(m.rendimento)}${extra}</td><td class="n">${pct(m.percentual)}</td>
        <td class="n">${pcdi != null ? pct(pcdi, 0) : "–"}</td><td class="n">${brl(m.final)}</td></tr>`;
    }).join("");
    return `<tbody class="${anosAbertos.has(ano) ? "aberto" : ""}" data-ano="${ano}">
      <tr class="ano"><td>${ano}</td><td class="muted" style="font-weight:400">${resumo}</td><td class="n">${brl(ms[0].anterior)}</td>
        <td class="n ${classeSinal(aporte)}">${brl(aporte)}</td><td class="n">${brl(rend)}</td><td></td><td></td><td class="n">${brl(ms[ms.length - 1].final)}</td></tr>
      ${linhas}</tbody>`;
  }).join("");
  $("#t-consolidado").innerHTML = cab + corpos;
}

// ------------------------------------------------------------------ LANÇAMENTO
let lanc = null;
async function carregarLancamento() {
  if (!$("#lanc-data").value) $("#lanc-data").value = hojeISO();
  const dia = $("#lanc-data").value;
  lanc = await api("GET", "/api/lancamento?data=" + dia);
  const dt = new Date(dia + "T12:00:00");
  $("#lanc-util").textContent = dt.toLocaleDateString("pt-BR", { weekday: "long" }) + (lanc.util ? "" : " · não é dia útil");
  $("#cards-lanc").innerHTML = lanc.itens.length ? lanc.itens.map((it, i) => `
    <div class="card-lanc" data-i="${i}">
      <div class="topo">
        <div><div class="nome">${esc(it.nome)}</div><div class="inst">${esc(it.instituicao || "")}</div></div>
        <span class="selo" id="selo-${i}"></span>
      </div>
      <dl>
        <dt>Último saldo${it.anterior_data ? ` <span class="muted">${diaMes(it.anterior_data)}</span>` : ""}</dt><dd>${brl(it.anterior_valor)}</dd>
        <dt>Aportes/resgates desde então</dt><dd class="${classeSinal(it.movimento)}">${it.movimento ? brl(it.movimento) : "–"}</dd>
        <dt>Saldo estimado</dt><dd class="muted">${brl(it.estimado)}</dd>
      </dl>
      <input class="valor grande" data-i="${i}" inputmode="decimal" placeholder="Saldo do dia" value="${it.saldo != null ? numBR(it.saldo) : ""}" aria-label="Saldo do dia de ${esc(it.nome)}">
      <div class="rend"><span class="muted">Rendimento</span><span class="v" id="rend-${i}">–</span></div>
      <div class="pdu muted" id="pdu-${i}"></div>
      <div class="alerta" id="alerta-${i}" hidden></div>
    </div>`).join("") : `<div class="cartao muted">Nenhuma aplicação ativa. Cadastre na aba Aplicações.</div>`;
  $$("#cards-lanc input").forEach(inp => {
    inp.addEventListener("input", () => atualizarCard(+inp.dataset.i));
    inp.addEventListener("focus", () => inp.select());
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        const prox = $(`#cards-lanc input[data-i="${+inp.dataset.i + 1}"]`);
        prox ? prox.focus() : salvarLancamento().catch(() => {});
      }
    });
    atualizarCard(+inp.dataset.i);
  });
  $("#t-mov-dia").innerHTML = lanc.movimentos.length
    ? `<tr><th>Aplicação</th><th class="n">Valor</th><th>Descrição</th><th></th></tr>` + lanc.movimentos.map(m =>
      `<tr><td>${esc(m.nome)}</td><td class="n ${classeSinal(m.valor)}">${brl(m.valor)}</td><td>${esc(m.descricao)}</td>
       <td><button class="link perigo" data-del-mov="${m.id}">excluir</button></td></tr>`).join("")
    : `<tr><td class="muted">Nenhum aporte ou resgate nesta data.</td></tr>`;
  carregarHistorico();
}

function atualizarCard(i) {
  const it = lanc.itens[i], inp = $(`#cards-lanc input[data-i="${i}"]`), v = parseNum(inp.value);
  const card = inp.closest(".card-lanc"), selo = $("#selo-" + i), cel = $("#rend-" + i), pdu = $("#pdu-" + i), alerta = $("#alerta-" + i);
  const alterado = v == null ? it.saldo != null : Number.isNaN(v) || it.saldo == null || Math.abs(v - it.saldo) > .004;
  card.classList.toggle("alterado", alterado);
  selo.className = "selo " + (alterado ? "pendente" : it.saldo != null ? "salvo" : "");
  selo.textContent = alterado ? "não salvo" : it.saldo != null ? "✓ salvo" : "sem lançamento";
  alerta.hidden = true;
  if (v == null || it.anterior_valor == null) { cel.textContent = "–"; cel.className = "v"; pdu.textContent = ""; return; }
  if (Number.isNaN(v)) { cel.textContent = "valor inválido"; cel.className = "v neg"; pdu.textContent = ""; return; }
  const r = v - it.anterior_valor - (it.movimento || 0), du = it.dias_uteis;
  cel.textContent = brl(r);
  cel.className = "v " + classeSinal(r);
  pdu.textContent = du ? `${brl(r / du)} por dia útil · ${du} dia(s) útil(eis) desde ${diaMes(it.anterior_data)}` : `nenhum dia útil desde ${diaMes(it.anterior_data)}`;
  const media = it.media_du;
  let msg = null;
  if (r < -0.005) msg = "Rendimento negativo. Confira o saldo e se houve resgate não registrado.";
  else if (media > 0 && du > 0 && (r / du > media * 3 || r / du < media / 3))
    msg = `Fora do padrão: a média recente é ${brl(media)} por dia útil. Confira o saldo e os aportes.`;
  else if (media > 0 && du === 0 && Math.abs(r) > media * 2)
    msg = "Variação grande sem dia útil no período. Confira o saldo.";
  if (msg) { alerta.textContent = msg; alerta.hidden = false; }
}

async function salvarLancamento() {
  if (!lanc) return;
  const itens = [];
  for (const inp of $$("#cards-lanc input")) {
    const v = parseNum(inp.value);
    if (Number.isNaN(v)) { toast("Há saldo com valor inválido.", true); inp.focus(); return; }
    itens.push({ aplicacao_id: lanc.itens[+inp.dataset.i].aplicacao_id, saldo: v });
  }
  const r = await api("POST", "/api/lancamento", { data: $("#lanc-data").value, itens });
  toast(`✓ ${r.gravados} saldo(s) gravado(s).`);
  await carregarLancamento();
  carregarResumo();
}

async function carregarHistorico() {
  const h = await api("GET", "/api/historico?dias=45");
  $("#t-historico").innerHTML = h.length
    ? `<tr><th>Data</th><th>Aplicação</th><th class="n">Rendimento</th><th class="n">Por dia útil</th></tr>` +
      h.map(x => `<tr title="Saldo ${brl(x.saldo)} · ${x.dias_uteis} dia(s) útil(eis)"><td>${diaMes(x.data)}</td><td>${esc(x.nome)}</td>
        <td class="n ${classeSinal(x.rendimento)}">${brl(x.rendimento)}</td>
        <td class="n">${x.dias_uteis ? brl(x.rendimento / x.dias_uteis) : "–"} <span class="muted">(${x.dias_uteis})</span></td></tr>`).join("")
    : `<tr><td class="muted">Sem lançamentos nos últimos 45 dias.</td></tr>`;
}

// ------------------------------------------------------------------ MOVIMENTOS
async function carregarMovimentos() {
  const f = $("#form-mov");
  if (!cp(f, "data").value) cp(f, "data").value = hojeISO();
  const id = $("#mov-filtro").value;
  const lst = await api("GET", "/api/movimentos" + (id ? "?aplicacao=" + id : ""));
  $("#t-mov").innerHTML = `<tr><th>Data</th><th>Aplicação</th><th class="n">Valor</th><th>Descrição</th><th></th></tr>` +
    lst.map(m => `<tr><td>${dataBR(m.data)}</td><td>${esc(m.nome)}</td><td class="n ${classeSinal(m.valor)}">${brl(m.valor)}</td>
      <td>${esc(m.descricao)}</td><td><button class="link" data-edit-mov='${esc(JSON.stringify(m))}'>editar</button>
      <button class="link perigo" data-del-mov="${m.id}">excluir</button></td></tr>`).join("");
}

async function salvarMovimento(form, data) {
  const d = formDados(form);
  const v = parseNum(d.valor);
  if (!v || Number.isNaN(v)) { toast("Informe um valor válido.", true); return false; }
  await api("POST", "/api/movimentos", {
    id: d.id || null, aplicacao_id: d.aplicacao_id, data: data || d.data,
    valor: Math.abs(v) * Number(d.tipo), descricao: d.descricao,
  });
  toast("✓ Movimento gravado.");
  carregarResumo();
  return true;
}

// ------------------------------------------------------------------ PROJEÇÃO
async function carregarProjecao() {
  const [sel, plan, cfg] = await Promise.all([api("GET", "/api/selic"), api("GET", "/api/planejados"), api("GET", "/api/config")]);
  const hoje = hojeISO();
  const origem = { bcb: "Banco Central", focus: "Focus", manual: "manual" };
  $("#t-selic").innerHTML = `<tr><th>A partir de</th><th class="n">Meta Selic</th><th>Origem</th><th></th></tr>` +
    sel.slice().reverse().map(s => `<tr class="${s.vigencia > hoje ? "projetado" : ""}"><td>${dataBR(s.vigencia)}</td>
      <td class="n">${numBR(s.taxa_aa)}%</td><td>${origem[s.origem] || s.origem}${s.vigencia > hoje ? " · futuro" : ""}</td>
      <td><button class="link perigo" data-del-selic="${s.id}">excluir</button></td></tr>`).join("");

  const c = cores();
  const ini = cfg.data_inicio.slice(0, 7), fim = cfg.data_meta.slice(0, 7);
  const meses = [];
  for (let a = +ini.slice(0, 4), m = +ini.slice(5); `${a}-${String(m).padStart(2, "0")}` <= fim; m === 12 ? (a++, m = 1) : m++)
    meses.push(`${a}-${String(m).padStart(2, "0")}`);
  const taxaEm = dia => { let t = sel.length ? sel[0].taxa_aa : null; for (const s of sel) if (s.vigencia <= dia) t = s.taxa_aa; return t; };
  const mesHoje = hoje.slice(0, 7);
  const valores = meses.map(m => taxaEm(m === mesHoje ? hoje : m + "-01"));
  const iHoje = meses.indexOf(mesHoje);
  grafico("g-selic", {
    type: "line",
    data: {
      labels: meses.map(mesBR), datasets: [
        { label: "Histórico", data: valores.map((v, i) => i <= iHoje ? v : null), stepped: true, borderColor: c.s1, backgroundColor: gradiente(c.s1, .18), fill: "start", borderWidth: 2, pointRadius: 0, pointHoverRadius: 5 },
        { label: "Cenário", data: valores.map((v, i) => i >= iHoje ? v : null), stepped: true, borderColor: c.s2, backgroundColor: c.s2, borderDash: [6, 4], borderWidth: 2, pointRadius: 0, pointHoverRadius: 5 },
      ],
    },
    options: opcoesBase(c, {
      plugins: {
        linhaHoje: { indice: iHoje, cor: c.muted },
        tooltip: { filter: it => it.raw != null && !(it.datasetIndex === 1 && it.dataIndex === iHoje), callbacks: { label: it => ` Selic: ${numBR(it.parsed.y)}% a.a.` } },
      },
      scales: { y: { ticks: { callback: v => v.toLocaleString("pt-BR") + "%" } } },
    }),
    plugins: [linhaHoje],
  });

  $("#t-plan").innerHTML = plan.length
    ? `<tr><th>Mês</th><th>Aplicação</th><th class="n">Valor</th><th></th></tr>` + plan.map(p =>
      `<tr><td>${mesBR(p.mes)}</td><td>${esc(p.nome)}</td><td class="n ${classeSinal(p.valor)}">${brl(p.valor)}</td>
       <td><button class="link perigo" data-del-plan="${p.id}">excluir</button></td></tr>`).join("")
    : `<tr><td class="muted">Nenhum aporte planejado.</td></tr>`;
}

// ------------------------------------------------------------------ APLICAÇÕES
async function carregarApps() {
  await carregarAplicacoes();
  const c = cores();
  $("#t-apps").innerHTML = `<tr><th>Nome</th><th>Instituição</th><th>Rendimento</th><th>Situação</th><th></th></tr>` +
    aplicacoes.map(a => `<tr><td><span class="amostra" style="background:${corApp(a.id, c)}"></span>${esc(a.nome)}</td><td>${esc(a.instituicao)}</td>
      <td>${a.tipo === "IPCA" ? "IPCA + " + numBR(a.taxa) + "% a.a." : numBR(a.taxa) + " " + TIPOS[a.tipo]}</td>
      <td>${a.ativa ? '<span class="sit realizado">ativa</span>' : `<span class="sit projetado">encerrada ${a.data_encerramento ? dataBR(a.data_encerramento) : ""}</span>`}</td>
      <td><button class="link" data-edit-app="${a.id}">editar</button><button class="link perigo" data-del-app="${a.id}">excluir</button></td></tr>`).join("");
}

// ------------------------------------------------------------------ CONFIGURAÇÕES
async function carregarConfig() {
  const cfg = await api("GET", "/api/config");
  preencher($("#form-cfg"), {
    ...cfg, spread_cdi: numBR(+cfg.spread_cdi), ipca_projetado: numBR(+cfg.ipca_projetado),
    cenario_variacao: numBR(+(cfg.cenario_variacao ?? 1)),
  });
  const sel = $("#fer-ano");
  if (!sel.options.length) {
    for (let a = 2024; a <= 2040; a++) sel.add(new Option(a, a));
    sel.value = new Date().getFullYear();
  }
  const fer = await api("GET", "/api/feriados?ano=" + sel.value);
  $("#t-fer").innerHTML = `<tr><th>Data</th><th>Dia</th><th>Descrição</th><th></th></tr>` + fer.map(f =>
    `<tr><td>${dataBR(f.data)}</td><td>${new Date(f.data + "T12:00:00").toLocaleDateString("pt-BR", { weekday: "short" })}</td>
     <td>${esc(f.descricao)}</td><td><button class="link perigo" data-del-fer="${f.data}">excluir</button></td></tr>`).join("");
}

// ------------------------------------------------------------------ eventos
document.addEventListener("click", async e => {
  // índice do tutorial: rola até a seção sem alterar o endereço (o # abre abas)
  const ancora = e.target.closest('.ajuda a[href^="#aj-"]');
  if (ancora) { e.preventDefault(); $(ancora.getAttribute("href")).scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  const anoRow = e.target.closest("tr.ano");
  if (anoRow) {
    const tb = anoRow.parentElement, ano = tb.dataset.ano;
    tb.classList.toggle("aberto");
    tb.classList.contains("aberto") ? anosAbertos.add(ano) : anosAbertos.delete(ano);
    return;
  }
  const b = e.target.closest("button");
  if (!b) return;
  const ds = b.dataset;
  try {
    if (ds.aba) return abrirAba(ds.aba);
    if (ds.periodo) { periodo = ds.periodo; guardar("periodo", periodo); return desenharPainel(); }
    if (ds.delMov && confirm("Excluir este movimento?")) {
      await api("DELETE", "/api/movimentos/" + ds.delMov);
      $("#aba-lancamento").classList.contains("ativa") ? carregarLancamento() : carregarMovimentos();
      carregarResumo();
    } else if (ds.editMov) {
      const m = JSON.parse(ds.editMov);
      preencher($("#form-mov"), { ...m, tipo: m.valor < 0 ? "-1" : "1", valor: numBR(Math.abs(m.valor)) });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (ds.delSelic) {
      await api("DELETE", "/api/selic/" + ds.delSelic); carregarProjecao(); carregarResumo();
    } else if (ds.delPlan) {
      await api("DELETE", "/api/planejados/" + ds.delPlan); carregarProjecao();
    } else if (ds.editApp) {
      const a = aplicacoes.find(x => x.id === +ds.editApp);
      preencher($("#form-app"), { ...a, taxa: numBR(a.taxa, 2) });
    } else if (ds.delApp && confirm("Excluir esta aplicação?")) {
      await api("DELETE", "/api/aplicacoes/" + ds.delApp); carregarApps();
    } else if (ds.delFer) {
      await api("DELETE", "/api/feriados/" + ds.delFer); carregarConfig();
    }
  } catch (err) { /* já exibido no toast */ }
});

document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && $("#aba-lancamento").classList.contains("ativa")) {
    e.preventDefault();
    salvarLancamento().catch(() => {});
  }
});

function ligar(id, fn) {
  $(id).addEventListener("click", async e => {
    e.preventDefault();
    const b = e.currentTarget;
    b.disabled = true;
    try { await fn(); } catch (err) { /* toast já exibido */ } finally { b.disabled = false; }
  });
}

ligar("#lanc-salvar", salvarLancamento);
ligar("#dia-ant", async () => { $("#lanc-data").value = somaDias($("#lanc-data").value, -1); await carregarLancamento(); });
ligar("#dia-prox", async () => { $("#lanc-data").value = somaDias($("#lanc-data").value, 1); await carregarLancamento(); });
ligar("#dia-hoje", async () => { $("#lanc-data").value = hojeISO(); await carregarLancamento(); });
$("#lanc-data").addEventListener("change", carregarLancamento);
ligar("#mov-dia-add", async () => {
  const f = $("#form-mov-dia");
  if (await salvarMovimento(f, $("#lanc-data").value)) {
    cp(f, "valor").value = ""; cp(f, "descricao").value = "";
    carregarLancamento();
  }
});

ligar("#mov-salvar", async () => {
  const f = $("#form-mov");
  if (await salvarMovimento(f)) {
    cp(f, "id").value = ""; cp(f, "valor").value = ""; cp(f, "descricao").value = "";
    carregarMovimentos();
  }
});
ligar("#mov-limpar", async () => {
  const f = $("#form-mov");
  cp(f, "id").value = ""; cp(f, "valor").value = ""; cp(f, "descricao").value = ""; cp(f, "data").value = hojeISO();
});
$("#mov-filtro").addEventListener("change", carregarMovimentos);

ligar("#selic-bcb", async () => {
  toast("Consultando o Banco Central…");
  const r = await api("POST", "/api/selic/bcb");
  toast(`✓ Selic atualizada: ${numBR(r.atual)}% a.a. desde ${dataBR(r.desde)}.`);
  carregarProjecao(); carregarResumo();
});
ligar("#selic-focus", async () => {
  if (!confirm("Substituir o cenário futuro da Selic pelas expectativas do Focus?")) return;
  toast("Consultando o Banco Central…");
  const r = await api("POST", "/api/selic/focus");
  const anos = Object.entries(r.anos).map(([a, t]) => `${a}: ${numBR(t)}%`).join(" · ");
  toast(`✓ Focus de ${dataBR(r.data_focus)} aplicado. ${anos}`);
  carregarProjecao();
});
ligar("#selic-limpar", async () => {
  if (!confirm("Apagar todas as taxas com vigência futura?")) return;
  await api("POST", "/api/selic/limpar-futuro"); carregarProjecao();
});
ligar("#selic-add", async () => {
  const f = $("#form-selic"), d = formDados(f), t = parseNum(d.taxa_aa);
  if (!d.vigencia || t == null || Number.isNaN(t)) return toast("Informe a data e a taxa.", true);
  await api("POST", "/api/selic", { vigencia: d.vigencia, taxa_aa: t });
  cp(f, "taxa_aa").value = "";
  carregarProjecao(); carregarResumo();
});

$("#plan-meses").innerHTML = MESES.map((m, i) => `<label><input type="checkbox" value="${i + 1}">${m}</label>`).join("");
ligar("#plan-salvar", async () => {
  const d = formDados($("#form-plan")), v = parseNum(d.valor);
  if (!d.de || v == null || Number.isNaN(v)) return toast("Informe o mês inicial e o valor.", true);
  const meses = $$("#plan-meses input:checked").map(x => +x.value);
  const r = await api("POST", "/api/planejados", { aplicacao_id: d.aplicacao_id, de: d.de, ate: d.ate || d.de, valor: v, meses });
  toast(`✓ ${r.meses} mês(es) atualizado(s).`);
  carregarProjecao();
});

ligar("#app-salvar", async () => {
  const d = formDados($("#form-app")), t = parseNum(d.taxa);
  if (t == null || Number.isNaN(t)) return toast("Informe a taxa.", true);
  await api("POST", "/api/aplicacoes", { ...d, id: d.id || null, taxa: t });
  preencher($("#form-app"), { ativa: true, tipo: "CDI" });
  toast("✓ Aplicação gravada.");
  carregarApps();
});
ligar("#app-limpar", async () => preencher($("#form-app"), { ativa: true, tipo: "CDI" }));

ligar("#cfg-salvar", async () => {
  const d = formDados($("#form-cfg"));
  await api("POST", "/api/config", {
    ...d, spread_cdi: parseNum(d.spread_cdi), ipca_projetado: parseNum(d.ipca_projetado), cenario_variacao: parseNum(d.cenario_variacao) ?? 0,
  });
  toast("✓ Parâmetros gravados.");
});
$("#fer-ano").addEventListener("change", carregarConfig);
ligar("#fer-add", async () => {
  const d = formDados($("#form-fer"));
  if (!d.data) return toast("Informe a data.", true);
  await api("POST", "/api/feriados", d);
  $("#fer-ano").value = d.data.slice(0, 4);
  carregarConfig();
});

$("#filtro-app").addEventListener("change", carregarPainel);
$("#so-realizado").addEventListener("change", desenharConsolidado);
ligar("#abrir-anos", async () => { painel?.meses.forEach(m => anosAbertos.add(m.mes.slice(0, 4))); desenharConsolidado(); });
ligar("#fechar-anos", async () => { anosAbertos.clear(); anosAbertos.add("nenhum"); desenharConsolidado(); });
$("#paleta").addEventListener("change", aplicarAparencia);
$("#modo").addEventListener("change", aplicarAparencia);
mqEscuro.addEventListener("change", () => { if (!$("#modo").value) aplicarAparencia(); });
$("#recolher").addEventListener("click", () => {
  const rec = document.documentElement.classList.toggle("menu-recolhido");
  guardar("menu", rec ? "recolhido" : "");
  setTimeout(() => Object.values(graficos).forEach(g => g.resize()), 220);
});

// ------------------------------------------------------------------ início
(async () => {
  $("#paleta").value = document.documentElement.dataset.paleta;
  $("#modo").value = ler("modo", "");
  await document.fonts?.ready;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 12;
  const params = new URLSearchParams(location.search);
  if (params.get("paleta") || params.get("modo")) {   // permite abrir já num tema (?paleta=noir&modo=dark)
    if (params.get("paleta")) $("#paleta").value = params.get("paleta");
    if (params.get("modo")) $("#modo").value = params.get("modo");
    aplicarAparencia();
  }
  let aba = ler("aba", "painel");
  if (location.hash.length > 1) aba = location.hash.slice(1);
  await carregarAplicacoes();
  carregarResumo();
  abrirAba(carregadores[aba] ? aba : "painel");
})();
