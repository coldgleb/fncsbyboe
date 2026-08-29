/* Общее: конфиг, состояние, загрузка листов, хелперы разметки, вкладки, сортировка таблиц */

const SHEET_ID = '1677JnB2uVlF0AQcS3x4m45ewpKyzJkRBmwCD7EfJBBg';
const COLORS = [
  '#e63946', '#f4a261', '#2ecc71', '#3498db', '#9b59b6',
  '#1abc9c', '#e67e22', '#2980b9', '#8e44ad', '#16a085',
  '#d35400', '#27ae60', '#c0392b', '#7f8c8d', '#f39c12'
];
const PAGE_SIZE = 20;

/* Дивизионы. Star лежит на своих листах; коалиций и зачёта им. Голубочкина в нём нет,
   а лист Round общий — календарь этапов один на оба дивизиона. */
const DIVISIONS = {
  open: { label: 'Open', races: 'Races', quals: 'Quals', coalitions: 'Coalitions', golub: true },
  star: { label: 'Star', races: 'Star Races', quals: 'Star Quals', golub: false },
};

const state = {
  division: new URLSearchParams(location.hash.slice(1)).get('div') === 'star' ? 'star' : 'open',
  races: { standings: [], rounds: [], rows: [] },
  quals: { standings: [], rounds: [], rows: [] },
  indRaces: { standings: [] },
  indQuals: { standings: [] },
  filter: { races: '', quals: '', indRaces: '', indQuals: '' },
  pivot: { races: '', quals: '' },
  golubFilter: { races: '', quals: '' },
  page: { races: 1, quals: 1, indRaces: 1, indQuals: 1 },
  // Срез зачёта: этап, после которого показываем таблицу (null — последний, т.е. весь сезон)
  upTo: { races: null, quals: null, indRaces: null, indQuals: null },
  sort: { races: null, quals: null, indRaces: null, indQuals: null },
  charts: {}
};

// Общий предикат поиска: пустой запрос пропускает всё, иначе — подстрока в любом из полей
function hit(q, ...fields) {
  const s = (q || '').trim().toLowerCase();
  return !s || fields.some(f => String(f ?? '').toLowerCase().includes(s));
}

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

/* Дисквалификация. В листе стоит «DQ», но gviz не отдаёт текст из числового столбца —
   приходит пустое место. Значит DQ — это «строка на этап есть, а места нет»; «не участвовал»
   отличается тем, что строки нет вовсе. Этап в зачёт не идёт (0 очков, вне статистики),
   но в протоколе пилот показывается там, где был бы по очкам за прогноз. */
const DQ_MARK = '<span class="dq-mark" title="Дисквалификация: этап не в зачёт">DQ</span>';

function coalMark(team) {
  return state.coalitions?.has(team) ? ' <span class="coal-mark" title="В коалиции">🤝</span>' : '';
}

/* Штраф с листа Deductions: из очков он уже вычтен, метка идёт перед ними и показывает,
   сколько сняли; подсказка — причина из столбца Reason, пустой Reason оставляет метку без неё.
   Причина пишется руками, поэтому кавычки экранируем — иначе они рвут сам атрибут title. */
function penMark(t) {
  if (!t.penalty) return '';
  const why = (t.penaltyReason || '').replace(/"/g, '&quot;');
  return `<span class="pen-mark"${why ? ` title="${why}"` : ''}>−${t.penalty}</span> `;
}

/* Производителя в листах пишут по-разному (Chevrolet, Chevy, Chv) — цвет бейджа
   и линии графика один и тот же, поэтому приводим написание к классу из CSS. */
const MFR_MATCH = [[/^(toy|tyt)/i, 'Toyota'], [/^(chev|chv)/i, 'Chevy'], [/^(ford|frd)/i, 'Ford']];
const mfrKey = mfr => MFR_MATCH.find(([re]) => re.test(mfr || ''))?.[1] || mfr;

function mfrBadge(mfr) {
  if (!mfr || mfr === '-') return '';
  return `<span class="mfr-badge ${mfrKey(mfr)}">${mfr}</span>`;
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
  // столбец места: сортируем по исходному месту в зачёте, а не по перенумерованному бейджу
  if (td?.dataset.rank != null) {
    const n = parseFloat(td.dataset.rank);
    return isFinite(n) ? n : null;              // «—» вместо места — вниз, как пустые
  }
  // метка штрафа стоит перед очками — сортировать надо по самим очкам, а не по «−100 494»
  const skip = td?.querySelector('.pen-mark')?.textContent ?? '';
  const t = (td?.textContent || '').slice(skip.length).trim();
  if (!t || t === '—' || t === '•' || t === 'DQ') return null;  // пусто и DQ — вниз
  const m = t.match(/^([▲▼])?\s*[P#+]?\s*(-?\d+(?:[.,]\d+)?)/);
  if (!m) return t.toLowerCase();
  const n = parseFloat(m[2].replace(',', '.'));
  return m[1] === '▼' ? -n : n;                                 // ▼3 — это −3
}

/* Места не ездят вместе со строками: после сортировки бейджи всегда 1..n сверху вниз.
   Исходное место в зачёте уходит в data-rank ячейки — по нему сортируется сам столбец места
   (клик по «#» возвращает исходный порядок) и живёт тултип. Бейдж места — только в первой
   ячейке строки; в карточке команды бейджем помечено место на этапе, его трогать нельзя. */
function renumberPlaces(body) {
  [...body.rows].forEach((tr, i) => {
    const badge = tr.cells[0]?.querySelector('.pos-badge');
    if (!badge) return;
    if (tr.cells[0].dataset.rank == null) tr.cells[0].dataset.rank = badge.textContent.trim();
    badge.textContent = i + 1;
    badge.title = `Место в зачёте: ${tr.cells[0].dataset.rank}`;
    for (const n of [1, 2, 3]) tr.classList.toggle(`rank-${n}`, i + 1 === n);
  });
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

  renumberPlaces(body);
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

/* Переключение дивизиона — перезагрузкой страницы: данные, фильтры, страницы, сортировки
   и графики другого дивизиона всё равно надо сбросить полностью, а дивизион уже в хэше. */
function switchDivision(name) {
  if (name === state.division || !DIVISIONS[name]) return;
  location.hash = `div=${name}&tab=races`;
  location.reload();
}

// Star: коалиций нет, значит нет и зачёта независимых (там независимы все), и зачёта им. Голубочкина
function applyDivision() {
  const div = DIVISIONS[state.division];
  document.querySelectorAll('.div-btn').forEach(b =>
    b.classList.toggle('rtog-active', b.dataset.div === state.division));

  const hidden = [...(div.golub ? [] : ['golub']), ...(div.coalitions ? [] : ['ind'])];
  for (const tab of ['golub', 'ind']) {
    const on = !hidden.includes(tab);
    document.querySelector(`.tab-btn[data-tab="${tab}"]`).style.display = on ? '' : 'none';
    if (!on && document.querySelector('.tab-btn.active')?.dataset.tab === tab) switchTab('races');
  }
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  writeHash();
}

/* ── Состояние в адресной строке: #tab=rounds&round=8&view=qual ── */
function writeHash() {
  const tab = document.querySelector('.tab-btn.active')?.dataset.tab || 'races';
  const parts = [`div=${state.division}`, `tab=${tab}`];
  const sel = document.getElementById('round-select');
  if (tab === 'rounds' && sel?.value) parts.push(`round=${sel.value}`, `view=${roundView}`);
  // replaceState, а не pushState — иначе «назад» отматывает каждый клик по вкладке
  history.replaceState(null, '', '#' + parts.join('&'));
}

// Читаем хэш, каким он был при открытии: рендер по пути успевает его перезаписать
const INITIAL_HASH = location.hash;

function applyHash() {
  const p = new URLSearchParams(INITIAL_HASH.slice(1));
  // вкладка из ссылки может быть скрыта в этом дивизионе — тогда остаёмся на гонках
  const tab = p.get('tab');
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  if (tab && document.getElementById(`tab-${tab}`) && btn?.style.display !== 'none') switchTab(tab);

  const round = p.get('round');
  const sel = document.getElementById('round-select');
  if (round && sel && [...sel.options].some(o => o.value === round)) {
    sel.value = round;
    const view = p.get('view');
    if (view) roundView = view;
    onRoundChange();
  }
}
