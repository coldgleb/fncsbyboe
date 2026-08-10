/* Общее: конфиг, состояние, загрузка листов, хелперы разметки, вкладки, сортировка таблиц */

const SHEET_ID = '1677JnB2uVlF0AQcS3x4m45ewpKyzJkRBmwCD7EfJBBg';
const COLORS = [
  '#e63946', '#f4a261', '#2ecc71', '#3498db', '#9b59b6',
  '#1abc9c', '#e67e22', '#2980b9', '#8e44ad', '#16a085',
  '#d35400', '#27ae60', '#c0392b', '#7f8c8d', '#f39c12'
];
const PAGE_SIZE = 20;

const state = {
  races: { standings: [], rounds: [], rows: [] },
  quals: { standings: [], rounds: [], rows: [] },
  indRaces: { standings: [] },
  indQuals: { standings: [] },
  filter: { races: '', quals: '', indRaces: '', indQuals: '' },
  pivot: { races: '', quals: '' },
  pivotTeam: { races: '', quals: '' },
  golubFilter: { races: '', quals: '' },
  golubTeam: { races: '', quals: '' },
  page: { races: 1, quals: 1, indRaces: 1, indQuals: 1 },
  sort: { races: null, quals: null, indRaces: null, indQuals: null },
  charts: {}
};

function fetchSheet(name) {
  return new Promise((resolve, reject) => {
    const cb = `_gviz_${name.replace(/\W/g, '')}_${Date.now()}`;
    const script = document.createElement('script');
    script.src = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=responseHandler:${cb}&sheet=${encodeURIComponent(name)}`;
    // JSONP умеет молча не ответить — без таймаута страница висит вечно
    const fail = msg => { clearTimeout(timer); delete window[cb]; script.remove(); reject(new Error(msg)); };
    const timer = setTimeout(() => fail(`Лист «${name}» не ответил за 15 секунд`), 15000);
    window[cb] = json => {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
      const cols = json.table.cols.map(c => c.label);
      resolve(json.table.rows.map(row => {
        const vals = row.c.map(c => c ? c.v : null);
        return Object.fromEntries(cols.map((col, i) => [col, vals[i]]));
      }));
    };
    script.onerror = () => fail(`Не удалось загрузить лист «${name}»`);
    document.head.appendChild(script);
  });
}

/* ── Round view ── */
function fmtRoundNum(n) {
  return n % 1 === 0 ? String(Math.round(n)) : String(n);
}

// Полное название этапа («8 · Bristol»); там, где не влезает, — roundLabel
function roundFullName(n) {
  return state.roundNames?.[String(n)] || roundLabel(n);
}

// Сокращение этапа с листа Round; у клэшей — с номером (DAY C1)
function roundLabel(n) {
  const abb = state.roundAbb?.[String(n)];
  if (!abb) return `Э${fmtRoundNum(n)}`;
  return n % 1 === 0 ? abb : `${abb} C${Math.round((n % 1) * 10)}`;
}

function coalMark(team) {
  return state.coalitions?.has(team) ? ' <span class="coal-mark" title="В коалиции">🤝</span>' : '';
}

function mfrBadge(mfr) {
  if (!mfr || mfr === '-') return '';
  return `<span class="mfr-badge ${mfr}">${mfr}</span>`;
}

// Общий блок страниц: onClick — функция, отдающая содержимое onclick для страницы p
function paginationHtml(page, pages, info, onClick) {
  let html = '<div class="pagination">';
  if (pages > 1) {
    if (page > 1) html += `<button class="page-btn" onclick="${onClick(page - 1)}">←</button>`;
    const lo = Math.max(1, page - 2), hi = Math.min(pages, page + 2);
    for (let p = lo; p <= hi; p++)
      html += `<button class="page-btn${p === page ? ' active' : ''}" onclick="${onClick(p)}">${p}</button>`;
    if (page < pages) html += `<button class="page-btn" onclick="${onClick(page + 1)}">→</button>`;
  }
  return html + `<span class="page-info">${info}</span></div>`;
}

/* ── Сортировка по клику на заголовок для любой таблицы с data-sort="auto" ──
   Работает по отрисованному тексту, поэтому годится и для результатов этапа, и для зачётов. */
function cellValue(td) {
  const t = (td?.textContent || '').trim();
  if (!t || t === '—' || t === '•') return null;                // пусто — особый случай
  const m = t.match(/^([▲▼])?\s*[P#+]?\s*(-?\d+(?:[.,]\d+)?)/);
  if (!m) return t.toLowerCase();
  const n = parseFloat(m[2].replace(',', '.'));
  return m[1] === '▼' ? -n : n;                                 // ▼3 — это −3
}

document.addEventListener('click', e => {
  const th = e.target.closest('th');
  const table = th && th.closest('table[data-sort="auto"]');
  if (!table) return;

  const idx = [...th.parentNode.children].indexOf(th);
  const asc = String(table.dataset.sortCol) === String(idx) ? table.dataset.sortDir !== 'asc' : true;
  const body = table.tBodies[0];
  if (!body) return;

  [...body.rows]
    .sort((a, b) => {
      const va = cellValue(a.cells[idx]), vb = cellValue(b.cells[idx]);
      // пустые всегда внизу — и при возрастании, и при убывании
      if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1;
      if (typeof va === 'string' || typeof vb === 'string')
        return (asc ? 1 : -1) * String(va).localeCompare(String(vb), 'ru');
      return asc ? va - vb : vb - va;
    })
    .forEach(r => body.appendChild(r));

  table.dataset.sortCol = idx;
  table.dataset.sortDir = asc ? 'asc' : 'desc';
  th.parentNode.querySelectorAll('.sort-arrow').forEach(a => a.remove());
  th.insertAdjacentHTML('beforeend', `<span class="sort-arrow">${asc ? '▲' : '▼'}</span>`);
});

function posClass(pos, maxPos) {
  if (pos == null) return 'pos-none';
  if (pos === 1) return 'pos-p1';
  if (pos <= 5) return 'pos-gray';
  if (pos <= 10) return 'pos-bronze';
  if (pos <= 20) return 'pos-green';
  if (pos <= (maxPos || 40)) return 'pos-purple';
  return 'pos-low';
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  writeHash();
}

/* ── Состояние в адресной строке: #tab=rounds&round=8&view=qual ── */
function writeHash() {
  const tab = document.querySelector('.tab-btn.active')?.dataset.tab || 'races';
  const parts = [`tab=${tab}`];
  const sel = document.getElementById('round-select');
  if (tab === 'rounds' && sel?.value) parts.push(`round=${sel.value}`, `view=${roundView}`);
  // replaceState, а не pushState — иначе «назад» отматывает каждый клик по вкладке
  history.replaceState(null, '', '#' + parts.join('&'));
}

// Читаем хэш, каким он был при открытии: рендер по пути успевает его перезаписать
const INITIAL_HASH = location.hash;

function applyHash() {
  const p = new URLSearchParams(INITIAL_HASH.slice(1));
  const tab = p.get('tab');
  if (tab && document.getElementById(`tab-${tab}`)) switchTab(tab);

  const round = p.get('round');
  const sel = document.getElementById('round-select');
  if (round && sel && [...sel.options].some(o => o.value === round)) {
    sel.value = round;
    const view = p.get('view');
    if (view) roundView = view;
    onRoundChange();
  }
}
