// ─────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────
const SHEET_ID  = '1404SCPiabg6abXRphpHqGXQ0frRkIlUptDV9m8a-x3w';
const SHEET_API = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json`;

// ─────────────────────────────────────────────────────────────────
// STATE
// Cada SKU "feito" guarda: anotação (margem, modificação, obs),
// a data em que foi marcado, e os números da planilha NAQUELE momento
// (estoqueNaEpoca, s7dNaEpoca, s30dNaEpoca) para comparar depois.
// ─────────────────────────────────────────────────────────────────
const STATE = {
  parados:  [],   // SKUs ainda parados (não marcados como feito)
  recentes: [],
  allItems: {},   // sku -> dados mais recentes da planilha (para refresh dos "feito")
  db: {},         // sku -> { margem, modificacao, obs, doneDate, estoqueNaEpoca, s7dNaEpoca, s30dNaEpoca, fornecedor, categoria }
  draft: {},      // sku -> { margem, modificacao, obs }  (anotações em digitação, ainda não marcadas como feito)
};

// ─────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadDB();
  loadDraft();

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('page-' + btn.dataset.page).classList.add('active');
      if (btn.dataset.page === 'apresentacao') renderApresentacao();
    });
  });

  document.getElementById('refreshBtn').addEventListener('click', fetchSheet);
  document.getElementById('exportBtn').addEventListener('click', exportCSV);

  document.getElementById('searchParados').addEventListener('input', renderParados);
  document.getElementById('filterCat').addEventListener('change', renderParados);
  document.getElementById('searchTrabalhados').addEventListener('input', renderTrabalhados);
  document.getElementById('filterSaida').addEventListener('change', renderTrabalhados);
  document.getElementById('searchRecentes').addEventListener('input', renderRecentes);

  fetchSheet();
});

// ─────────────────────────────────────────────────────────────────
// FETCH SHEET
// ─────────────────────────────────────────────────────────────────
async function fetchSheet() {
  setLoading(true);

  // "Visão Geral" é a aba correta com os dados consolidados — tenta primeiro
  const sheetNames = ['Visão Geral', 'Fluxo por SKU', 'FluxoV2', 'Sheet1', 'Página1'];
  let rows = null;
  let lastError = '';

  for (const name of sheetNames) {
    try {
      const url  = `${SHEET_API}&sheet=${encodeURIComponent(name)}&cachebust=${Date.now()}`;
      const res  = await fetch(url);
      if (!res.ok) { lastError = `HTTP ${res.status} na aba "${name}"`; continue; }
      const text = await res.text();
      const parsed = parseGVizResponse(text);
      if (parsed && parsed.length > 3) { rows = parsed; break; }
      lastError = `Aba "${name}" respondeu mas sem dados suficientes (${parsed ? parsed.length : 0} linhas)`;
    } catch (e) { lastError = `Erro de rede na aba "${name}": ${e.message}`; }
  }

  if (!rows) {
    try {
      const url  = `${SHEET_API}&cachebust=${Date.now()}`;
      const res  = await fetch(url);
      const text = await res.text();
      rows = parseGVizResponse(text);
    } catch (e) { lastError = e.message; }
  }

  if (!rows || rows.length < 3) {
    setLoading(false, `❌ Não foi possível carregar a planilha. ${lastError || 'Verifique se ela está pública.'}`);
    return;
  }

  processData(rows);
}

function parseGVizResponse(text) {
  const match = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\)/);
  if (!match) return null;
  let data;
  try { data = JSON.parse(match[1]); } catch (e) { return null; }
  if (!data.table || !data.table.rows) return null;

  // O Google já separa o cabeçalho em data.table.cols — NÃO vem dentro de rows.
  // Construímos a primeira linha do nosso array a partir dos labels das colunas,
  // e o restante são os dados reais (sem perder nem duplicar nenhuma linha).
  const headerRow = (data.table.cols || []).map(c => c.label || '');
  const dataRows = data.table.rows.map(row =>
    row.c.map(cell => (cell && cell.v !== null && cell.v !== undefined) ? cell.v : '')
  );
  return [headerRow, ...dataRows];
}

// ─────────────────────────────────────────────────────────────────
// PROCESS DATA
// Re-roda a cada "Atualizar": recalcula parados, recentes, e
// atualiza os dados mais novos de TODOS os SKUs (inclusive os já
// marcados como feito, para detectar se passaram a ter saída).
// ─────────────────────────────────────────────────────────────────
function processData(rows) {
  // Com o parser corrigido, a linha 0 é sempre o cabeçalho real (vem de data.table.cols)
  const headerIdx = 0;

  const header = rows[headerIdx] || [];
  // Posições confirmadas na planilha real (coluna A fica vazia/oculta):
  // 0=vazio 1=Fornecedor 2=SKUs 3=Categorias 4=Estoque WMS ... 7=7dias 8=30dias 9=60dias
  let colSKU = 2, colForn = 1, colCat = 3, colEstoque = 4, colS7 = 7, colS30 = 8, colS60 = 9;

  header.forEach((h, i) => {
    const lh = String(h).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    if (lh.includes('evoluc')) return; // ignora "Evolução últimos X dias" — não é a coluna de vendas
    if (/^skus?$/.test(lh))                          colSKU     = i;
    else if (lh.includes('fornecedor'))               colForn    = i;
    else if (lh.includes('categor'))                  colCat     = i;
    else if (lh === 'estoque wms' || (lh.includes('estoque') && lh.includes('wms'))) colEstoque = i;
    else if (lh.includes('60') && lh.includes('dia'))  colS60     = i;
    else if (lh.includes('30') && lh.includes('dia'))  colS30     = i;
    else if (lh.includes('7')  && lh.includes('dia'))  colS7      = i;
  });

  const parados = [], recentes = [];
  const allItems = {};
  const cats = new Set();

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const sku = String(r[colSKU] || '').trim();
    if (!sku || sku.length < 2) continue;
    if (/sku|fornecedor|para produto/i.test(sku)) continue;

    const fornecedor = String(r[colForn] || '').trim();
    const categoria  = String(r[colCat]  || '').trim();
    const estoque    = toNum(r[colEstoque]);
    const s7d        = toNum(r[colS7]);
    const s30d       = toNum(r[colS30]);
    const s60d       = toNum(r[colS60]);

    const item = { sku, fornecedor, categoria, estoque, s7d, s30d, s60d };
    allItems[sku] = item;
    if (categoria) cats.add(categoria);

    const jaFeito = !!STATE.db[sku];

    // Parados: estoque>0, 60d=0, e AINDA NÃO marcado como feito
    if (estoque > 0 && s60d === 0 && !jaFeito) parados.push(item);

    // Recém ativos: estoque>0 e 60d>0
    if (estoque > 0 && s60d > 0) recentes.push(item);
  }

  STATE.parados  = parados;
  STATE.recentes = recentes;
  STATE.allItems = allItems;

  // Filtro de categorias
  const sel = document.getElementById('filterCat');
  const curVal = sel.value;
  sel.innerHTML = '<option value="">Todas categorias</option>';
  [...cats].sort().forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c; sel.appendChild(o);
  });
  sel.value = curVal;

  const now = new Date();
  document.getElementById('lastUpdate').textContent =
    `Atualizado: ${now.toLocaleDateString('pt-BR')} ${now.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'})}`;

  setLoading(false);
  document.getElementById('tblParados').style.display = 'table';

  updateBadges();
  renderParados();
  renderTrabalhados();
  renderRecentes();

  toast(`✓ Planilha atualizada — ${parados.length} parados, ${Object.keys(STATE.db).length} já feitos`);
}

// ─────────────────────────────────────────────────────────────────
// RENDER: PARADOS (com edição inline + checkbox "Feito")
// ─────────────────────────────────────────────────────────────────
function renderParados() {
  const search = document.getElementById('searchParados').value.toLowerCase();
  const cat    = document.getElementById('filterCat').value;

  const items = STATE.parados.filter(item => {
    if (search &&
        !item.sku.toLowerCase().includes(search) &&
        !item.fornecedor.toLowerCase().includes(search) &&
        !item.categoria.toLowerCase().includes(search)) return false;
    if (cat && item.categoria !== cat) return false;
    return true;
  });

  const tbody = document.getElementById('bodyParados');
  const empty = document.getElementById('emptyParados');
  const tbl   = document.getElementById('tblParados');

  if (items.length === 0) {
    tbl.style.display = 'none';
    empty.style.display = 'block';
  } else {
    tbl.style.display = 'table';
    empty.style.display = 'none';

    tbody.innerHTML = items.map(item => {
      const d = STATE.draft[item.sku] || {};
      return `<tr id="row-${rowId(item.sku)}">
        <td><span class="mono">${item.sku}</span></td>
        <td>${item.fornecedor || '—'}</td>
        <td>${item.categoria  || '—'}</td>
        <td style="text-align:right" class="mono">${item.estoque}</td>
        <td>
          <input type="number" class="inline-input" placeholder="%" step="0.1"
            value="${d.margem || ''}"
            oninput="updateDraft('${esc(item.sku)}','margem',this.value)" />
        </td>
        <td>
          <select class="inline-input" onchange="updateDraft('${esc(item.sku)}','modificacao',this.value)">
            <option value="">Selecione...</option>
            ${['Redução de preço','Promoção / Cupom','Melhoria de título','Troca de categoria','Anúncio patrocinado','Kit / Bundle','Revisão de fotos','Outro']
              .map(o => `<option ${d.modificacao===o?'selected':''}>${o}</option>`).join('')}
          </select>
        </td>
        <td>
          <input type="text" class="inline-input" placeholder="Observação..."
            value="${escAttr(d.obs || '')}"
            oninput="updateDraft('${esc(item.sku)}','obs',this.value)" />
        </td>
        <td class="checkbox-wrap">
          <input type="checkbox" class="check-feito" title="Marcar como feito"
            onchange="marcarFeito('${esc(item.sku)}', this)" />
        </td>
      </tr>`;
    }).join('');
  }

  const total = STATE.parados.length;
  const trab  = Object.keys(STATE.db).length;
  const saida = Object.values(STATE.db).filter(r => r.resultadoSaida).length;
  document.getElementById('s-total').textContent        = total;
  document.getElementById('s-trabalhados').textContent  = trab;
  document.getElementById('s-pendentes').textContent    = total;
  document.getElementById('s-saida').textContent        = saida;
}

function updateDraft(sku, field, value) {
  if (!STATE.draft[sku]) STATE.draft[sku] = {};
  STATE.draft[sku][field] = value;
  saveDraft();
}

// ─────────────────────────────────────────────────────────────────
// MARCAR FEITO — move o SKU da lista de Parados para Já Feito
// ─────────────────────────────────────────────────────────────────
function marcarFeito(sku, checkbox) {
  const item  = STATE.parados.find(p => p.sku === sku);
  const draft = STATE.draft[sku] || {};

  if (!draft.modificacao) {
    toast('⚠ Selecione o tipo de modificação antes de marcar como feito');
    checkbox.checked = false;
    return;
  }

  STATE.db[sku] = {
    fornecedor: item ? item.fornecedor : '',
    categoria:  item ? item.categoria  : '',
    margem:      draft.margem || '',
    modificacao: draft.modificacao || '',
    obs:         draft.obs || '',
    doneDate:    new Date().toISOString(),
    // Snapshot do momento em que foi marcado — usado para detectar mudança depois
    estoqueNaEpoca: item ? item.estoque : 0,
    s7dNaEpoca:     item ? item.s7d : 0,
    s30dNaEpoca:    item ? item.s30d : 0,
    resultadoSaida: false,
  };

  delete STATE.draft[sku];
  saveDB();
  saveDraft();

  // Remove visualmente da lista de parados
  STATE.parados = STATE.parados.filter(p => p.sku !== sku);

  toast(`✓ ${sku} marcado como feito — movido para "Já Feito"`);
  updateBadges();
  renderParados();
  renderTrabalhados();
}

// ─────────────────────────────────────────────────────────────────
// RENDER: TRABALHADOS (JÁ FEITO)
// Compara os dados atuais da planilha com o snapshot do momento
// em que foi marcado, usando OR entre 7d e 30d (sem somar).
// ─────────────────────────────────────────────────────────────────
function renderTrabalhados() {
  const search      = document.getElementById('searchTrabalhados').value.toLowerCase();
  const filterSaida = document.getElementById('filterSaida').value;

  const entries = Object.entries(STATE.db).map(([sku, rec]) => {
    const atual = STATE.allItems[sku];
    const s7Atual  = atual ? atual.s7d  : rec.s7dNaEpoca;
    const s30Atual = atual ? atual.s30d : rec.s30dNaEpoca;

    // Teve saída se, depois da modificação, a venda de 7d OU 30d aumentou
    // em relação ao que era no momento em que foi marcado.
    const teveSaida = (s7Atual > rec.s7dNaEpoca) || (s30Atual > rec.s30dNaEpoca);

    rec.resultadoSaida = teveSaida; // guarda para os contadores
    return { sku, ...rec, s7Atual, s30Atual, teveSaida };
  });

  entries.sort((a, b) => new Date(b.doneDate) - new Date(a.doneDate));

  const filtered = entries.filter(e => {
    if (search && !e.sku.toLowerCase().includes(search) && !(e.obs||'').toLowerCase().includes(search)) return false;
    if (filterSaida === 'sim' && !e.teveSaida) return false;
    if (filterSaida === 'nao' && e.teveSaida)  return false;
    return true;
  });

  const tbody = document.getElementById('bodyTrabalhados');
  const empty = document.getElementById('emptyTrabalhados');

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = filtered.map(e => {
    const resultBadge = e.teveSaida
      ? '<span class="badge badge-green">✅ Teve saída</span>'
      : '<span class="badge badge-warn">🕐 Ainda sem saída</span>';

    return `<tr>
      <td><span class="mono">${e.sku}</span></td>
      <td>${e.fornecedor || '—'}</td>
      <td>${fmtDate(e.doneDate)}</td>
      <td class="mono">${e.margem ? e.margem + '%' : '—'}</td>
      <td>${e.modificacao || '—'}</td>
      <td style="max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escAttr(e.obs||'')}">${e.obs || '—'}</td>
      <td class="mono" style="text-align:center">${e.s7Atual}</td>
      <td class="mono" style="text-align:center">${e.s30Atual}</td>
      <td>${resultBadge}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="desfazerFeito('${esc(e.sku)}')">Reabrir</button></td>
    </tr>`;
  }).join('');

  updateBadges();
}

function desfazerFeito(sku) {
  if (!confirm(`Remover ${sku} de "Já Feito" e voltar para a lista de Parados?`)) return;
  delete STATE.db[sku];
  saveDB();
  toast(`${sku} voltou para SKUs Parados`);
  fetchSheet(); // re-processa para recolocar na lista de parados se ainda se qualificar
}

// ─────────────────────────────────────────────────────────────────
// RENDER: RECENTES
// ─────────────────────────────────────────────────────────────────
function renderRecentes() {
  const search = document.getElementById('searchRecentes').value.toLowerCase();
  const items  = STATE.recentes.filter(i =>
    !search || i.sku.toLowerCase().includes(search) ||
    i.fornecedor.toLowerCase().includes(search) ||
    i.categoria.toLowerCase().includes(search)
  );

  const tbody = document.getElementById('bodyRecentes');
  const empty = document.getElementById('emptyRecentes');

  if (items.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = items.map(i => `<tr>
    <td><span class="mono">${i.sku}</span></td>
    <td>${i.fornecedor || '—'}</td>
    <td>${i.categoria  || '—'}</td>
    <td style="text-align:right" class="mono">${i.estoque}</td>
    <td style="text-align:right" class="mono">${i.s60d}</td>
    <td style="text-align:right" class="mono">${i.s30d}</td>
    <td style="text-align:right" class="mono">${i.s7d}</td>
  </tr>`).join('');
}

// ─────────────────────────────────────────────────────────────────
// RENDER: APRESENTAÇÃO
// ─────────────────────────────────────────────────────────────────
function renderApresentacao() {
  // Garante que resultadoSaida está atualizado
  renderTrabalhados();

  const totalParados   = STATE.parados.length + Object.keys(STATE.db).length; // todos que já foram ou estão parados
  const modificados    = Object.keys(STATE.db).length;
  const comSaida        = Object.values(STATE.db).filter(r => r.resultadoSaida).length;
  const semSaidaAinda    = modificados - comSaida;
  const pendentes        = STATE.parados.length;
  const conv             = modificados ? Math.round(comSaida / modificados * 100) : 0;

  document.getElementById('p-parados').textContent        = STATE.parados.length;
  document.getElementById('p-modificados').textContent    = modificados;
  document.getElementById('p-com-saida').textContent       = comSaida;
  document.getElementById('p-sem-saida-ainda').textContent = semSaidaAinda;
  document.getElementById('p-pendentes').textContent       = pendentes;
  document.getElementById('p-conversao').textContent       = modificados ? conv + '%' : '—';
  document.getElementById('p-recentes').textContent        = STATE.recentes.length;

  const modPct = totalParados ? Math.round(modificados / totalParados * 100) : 0;
  document.getElementById('bar-mod').style.width   = modPct + '%';
  document.getElementById('bar-mod-pct').textContent = modPct + '%';
  document.getElementById('bar-saida').style.width   = conv + '%';
  document.getElementById('bar-saida-pct').textContent = conv + '%';

  renderWeekHistory();
}

function renderWeekHistory() {
  const byWeek = {};
  Object.entries(STATE.db).forEach(([sku, rec]) => {
    const d   = new Date(rec.doneDate);
    const mon = new Date(d);
    const wd  = d.getDay();
    mon.setDate(d.getDate() - (wd === 0 ? 6 : wd - 1));
    mon.setHours(0, 0, 0, 0);
    const key = mon.toISOString().slice(0, 10);
    if (!byWeek[key]) byWeek[key] = [];
    byWeek[key].push({ sku, ...rec });
  });

  const weeks     = Object.keys(byWeek).sort().reverse();
  const container = document.getElementById('weekHistory');

  if (weeks.length === 0) {
    container.innerHTML = '<div class="empty"><p>Nenhum SKU modificado ainda.</p></div>';
    return;
  }

  container.innerHTML = weeks.map(wk => {
    const entries  = byWeek[wk];
    const skuCount = entries.length;
    const saidas   = entries.filter(e => e.resultadoSaida).length;
    const semSaida = skuCount - saidas;
    const d        = new Date(wk);
    const endD     = new Date(d); endD.setDate(d.getDate() + 6);
    const c        = skuCount ? Math.round(saidas / skuCount * 100) : 0;

    return `<div class="week-card">
      <div class="week-title" style="border:none;padding:0;margin-bottom:10px">
        ${fmtDate(d.toISOString())} → ${fmtDate(endD.toISOString())}
        <span style="font-size:12px;color:var(--muted);font-weight:400;margin-left:8px">${skuCount} SKUs modificados · ${c}% conversão</span>
      </div>
      <div class="week-meta">
        <span><span class="dot dot-accent"></span>${skuCount} modificados</span>
        <span><span class="dot dot-green"></span>${saidas} com saída</span>
        <span><span class="dot dot-warn"></span>${semSaida} sem saída ainda</span>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${entries.map(e => {
          const cls = e.resultadoSaida ? 'badge-green' : 'badge-warn';
          return `<span class="badge ${cls}">${e.sku}</span>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────
// EXPORT CSV
// ─────────────────────────────────────────────────────────────────
function exportCSV() {
  const rows = ['SKU;Fornecedor;Categoria;Data Modificação;Margem%;Modificação;Observação;Saída7d;Saída30d;TeveSaída'];
  Object.entries(STATE.db).forEach(([sku, rec]) => {
    const atual = STATE.allItems[sku];
    const s7Atual  = atual ? atual.s7d  : rec.s7dNaEpoca;
    const s30Atual = atual ? atual.s30d : rec.s30dNaEpoca;
    const teveSaida = (s7Atual > rec.s7dNaEpoca) || (s30Atual > rec.s30dNaEpoca);
    rows.push([sku, rec.fornecedor, rec.categoria, fmtDate(rec.doneDate), rec.margem, rec.modificacao, (rec.obs||'').replace(/;/g,' '), s7Atual, s30Atual, teveSaida ? 'Sim' : 'Não'].join(';'));
  });
  const a = document.createElement('a');
  a.href  = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' }));
  a.download = `sku_analytics_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ─────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────
function updateBadges() {
  document.getElementById('badge-parados').textContent     = STATE.parados.length;
  document.getElementById('badge-trabalhados').textContent = Object.keys(STATE.db).length;
  document.getElementById('badge-recentes').textContent    = STATE.recentes.length;
}

function setLoading(on, msg) {
  const el  = document.getElementById('loadingParados');
  const tbl = document.getElementById('tblParados');
  if (on) {
    el.innerHTML = '<div class="spinner"></div><p>Carregando dados da planilha...</p>';
    el.style.display = 'block';
    tbl.style.display = 'none';
  } else if (msg) {
    el.innerHTML = `<p style="color:var(--danger)">${msg}</p>`;
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  return parseFloat(String(v).replace(/[^0-9,.\-]/g, '').replace(',', '.')) || 0;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('pt-BR');
}

function rowId(sku) { return sku.replace(/[^a-zA-Z0-9]/g, '_'); }
function esc(s)      { return (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function escAttr(s)  { return (s || '').replace(/"/g, '&quot;'); }

function saveDB()   { localStorage.setItem('skuDB', JSON.stringify(STATE.db)); }
function loadDB()   { try { STATE.db = JSON.parse(localStorage.getItem('skuDB') || '{}'); } catch { STATE.db = {}; } }
function saveDraft(){ localStorage.setItem('skuDraft', JSON.stringify(STATE.draft)); }
function loadDraft(){ try { STATE.draft = JSON.parse(localStorage.getItem('skuDraft') || '{}'); } catch { STATE.draft = {}; } }
