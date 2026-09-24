/* Общее: конфиг, состояние, загрузка листов, хелперы разметки, вкладки, сортировка таблиц */

// Каждый сезон лежит на своей таблице Google Sheets — новый год дописывается сюда
const SHEETS_BY_YEAR = {
  2026: '1GgX1hcmKSWjzhryDz-M0y_wgknu6VSGvz-jLU25bKlY',
};
const SEASONS = Object.keys(SHEETS_BY_YEAR).map(Number);
const COLORS = [
  '#ffd23f', '#5aa9ff', '#5ed16a', '#c9a2ff', '#3ee0c5',
  '#ff8f5e', '#e0699b', '#89b4ff', '#d86c3c', '#4bbf8f',
  '#b06bd6', '#2f9bd8', '#e4c04a', '#9fb0c4', '#f5d90a'
];
const SHOW_ROWS = 20;   // общие зачёты: столько строк видно до «Показать все»

/* Правила зачётов считает база (db/api.sql). Здесь — только то, что нужно для показа:
   дуэли 1.1/1.2 — часть первого этапа, а Чейз (и его тумблер) — после 26 этапа. */
const SPRINT_ROUNDS = new Set([1.1, 1.2]);
const CHASE_START = 26;
// команда пилота и средняя позиция — уже посчитаны базой, это их вид в таблицах
const teamOf = driver => state.teamOf?.[driver] || '—';
const avgPos = s => (s.finishes ? (s.posSum / s.finishes).toFixed(1) : '—');

/* Дивизионы. Star лежит на своих листах; коалиций и зачёта им. Голубочкина в нём нет,
   а лист Round общий — календарь этапов один на оба дивизиона. */
/* Дивизионы. Данные лежат в одной таблице (лист results), поэтому здесь только то, что
   отличается на экране: подпись, наличие заявок (метрика команд) и зачёта им. Голубочкина.
   Имена «Open Races» и т. п. остались для калькулятора — он просит протоколы по прежним именам. */
const DIVISIONS = {
  open: { label: 'Open', races: 'Open Races', quals: 'Open Quals', entries: true, golub: true },
  star: { label: 'Star', races: 'Star Races', quals: 'Star Quals', entries: true, golub: false },
};

const YEARS = [...SEASONS].sort((a, b) => b - a);

const state = {
  year: (() => {
    const y = Number(new URLSearchParams(location.hash.slice(1)).get('year'));
    return SEASONS.includes(y) ? y : YEARS[0];
  })(),
  division: new URLSearchParams(location.hash.slice(1)).get('div') === 'star' ? 'star' : 'open',
  races: { standings: [], rounds: [], rows: [] },
  quals: { standings: [], rounds: [], rows: [] },
  filter: { races: '', quals: '' },
  pivot: { races: '', quals: '' },
  golubFilter: { races: '', quals: '' },
  // раскрыт ли спойлер «Показать все» у зачёта: races, quals, teams, owners
  showAll: {},
  // Срез зачёта: этап, после которого показываем таблицу (null — последний, т.е. весь сезон)
  upTo: { races: null, quals: null, owners: null },
  // Переключатель «Регулярный сезон / Чейз»: 'auto' — с 27 этапа сам Чейз, до этого
  // обычный сезон; 'regular'/'chase' — явный выбор пользователя, виден с 26 этапа
  chaseView: { races: 'auto', quals: 'auto', owners: 'auto' },
  sort: { races: null, quals: null },
  // когда данные реально приехали с листов (у кэшированных — время их загрузки)
  dataTs: null,
  charts: {}
};

// Общий предикат поиска: пустой запрос пропускает всё, иначе — подстрока в любом из полей
function hit(q, ...fields) {
  const s = (q || '').trim().toLowerCase();
  return !s || fields.some(f => String(f ?? '').toLowerCase().includes(s));
}

// Гость — либо явно помечен «(i)» в имени, либо в этом сезоне сменил дивизион
// (лист Changes) и в ТЕКУЩЕМ дивизионе это — его старый, откуда он ушёл
const isGuestDriver = d => d.includes('(i)') || (state.guestByChange?.has(d) ?? false);

/* ── Числа ──
   Из базы числовые поля приходят числами, но приведение оставлено страховкой: если
   значение когда-нибудь окажется строкой («12.5» или «12,5»), расчёты не сломаются.
   Поля перечислены явно — «#» это номер машины со значащим нулём («09»). */
const NUM_KEYS = new Set(['Round', 'Pos.', 'QL', 'DR1', 'DR2', 'DR3', 'DR4', 'DUE', 'CAU', 'RET', 'MN', 'Points']);

function toNum(v) {
  if (typeof v !== 'string') return v;
  const s = v.replace(/[\s ]/g, '').replace(',', '.');
  if (!s || s === '—' || s === '–' || s === '-') return null;
  const n = Number(s);
  return isFinite(n) ? n : v;   // не число — оставляем как есть (метки вроде DQ)
}

/* ── Кэш листов в браузере ──
   Данные за день меняются считанные разы: держим разобранные строки в localStorage
   12 часов. Принудительно свежие — кнопка «Обновить» в шапке (init(true)); обычная
   перезагрузка страницы берёт кэш. Версию поднимаем, когда меняется формат данных. */
const CACHE_V = 6;   // формат данных сменился — прежний кэш не годится
const CACHE_TTL = 12 * 3600 * 1000;
const cacheKey = name => `fncs:${CACHE_V}:${state.year}:${name}`;

// Время самых старых использованных данных — его показывает шапка вместо «сейчас»
function noteDataTs(ts) {
  state.dataTs = state.dataTs == null ? ts : Math.min(state.dataTs, ts);
}

function cacheRead(name) {
  try {
    const raw = localStorage.getItem(cacheKey(name));
    if (!raw) return null;
    const { ts, rows } = JSON.parse(raw);
    if (!ts || !rows || Date.now() - ts > CACHE_TTL) return null;
    noteDataTs(ts);
    return rows;
  } catch (e) { return null; }     // приватный режим, заблокированные site data, битая запись
}

function cacheWrite(name, rows, ts) {
  try {
    localStorage.setItem(cacheKey(name), JSON.stringify({ ts, rows }));
  } catch (e) {
    cacheClear();                  // чаще всего это переполнение — освобождаем и живём без кэша
    try { localStorage.setItem(cacheKey(name), JSON.stringify({ ts, rows })); } catch (e2) { }
  }
}

// Чистим только свои ключи: рядом в localStorage лежит выбранная тема
function cacheClear() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('fncs:')) localStorage.removeItem(k);
  } catch (e) { }
}

/* ── Данные ──
   Исходные протоколы лежат в Google Sheets и грузятся через gviz (JSONP — CORS у
   Google закрыт). Разобранные строки держим в кэше браузера 12 часов, кнопка
   «Обновить» идёт мимо кэша. Готовые таблицы (зачёты, сводные, метрика) собирает
   js/local-api.js тем же расчётом, что проверен тестами. */

// имя колбэка должно быть уникальным: один и тот же лист могут спросить два места сразу
let jsonpSeq = 0;

function loadSheet(name) {
  return new Promise((resolve, reject) => {
    const cb = `_gviz_${name.replace(/\W/g, '')}_${++jsonpSeq}`;
    const script = document.createElement('script');
    script.src = `https://docs.google.com/spreadsheets/d/${SHEETS_BY_YEAR[state.year]}/gviz/tq`
      // headers=1: шапка — всегда первая строка (сам gviz её не узнаёт, если под ней смешанные типы)
      + `?tqx=responseHandler:${cb}&headers=1&sheet=${encodeURIComponent(name)}`;
    // JSONP умеет молча не ответить — без таймаута страница висит вечно
    const fail = msg => { clearTimeout(timer); delete window[cb]; script.remove(); reject(new Error(msg)); };
    const timer = setTimeout(() => fail(`Лист «${name}» не ответил за 20 секунд`), 20000);
    window[cb] = json => {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
      // Лист без настоящей шапки (gviz её не распознал) отдаёт пустой label у всех
      // колонок — тогда одноимёнными ключами схлопнется всё, кроме последней колонки;
      // берём id столбца ('A', 'B', …) как запасной уникальный ключ
      const cols = json.table.cols.map(c => c.label || c.id);
      resolve(json.table.rows.map(row => {
        const vals = row.c.map(c => (c ? c.v : null));
        return Object.fromEntries(cols.map((col, i) => [col, NUM_KEYS.has(col) ? toNum(vals[i]) : vals[i]]));
      }));
    };
    script.onerror = () => fail(`Не удалось загрузить лист «${name}»`);
    document.head.appendChild(script);
  });
}

async function fetchSheet(name, fresh) {
  if (!fresh) {
    const cached = cacheRead(name);
    if (cached) return cached;
  }
  // JSONP иногда молча не отвечает (Google придерживает пачку запросов) — пробуем ещё раз
  const rows = await loadSheet(name).catch(() => loadSheet(name));
  const ts = Date.now();
  noteDataTs(ts);
  cacheWrite(name, rows, ts);
  return rows;
}

/* Готовая таблица по имени и параметрам — считает js/local-api.js */
function rpc(fn, params = {}, fresh = false) {
  return localRpc(fn, params, fresh);
}

/* ── Round view ── */
function fmtRoundNum(n) {
  return n % 1 === 0 ? String(Math.round(n)) : String(n);
}

// Полное название этапа («8 · Bristol»); там, где не влезает, — roundLabel
function roundFullName(n) {
  return state.roundNames?.[String(n)] || roundLabel(n);
}

// Сокращение этапа с листа Round; у дуэлей — с номером (DAY D1)
function roundLabel(n) {
  const abb = state.roundAbb?.[String(n)];
  if (!abb) return `Э${fmtRoundNum(n)}`;
  return n % 1 === 0 ? abb : `${abb} D${Math.round((n % 1) * 10)}`;
}

/* Дисквалификация. В листе стояло «DQ», а в базе место просто не заполнено.
   Значит DQ — это «строка на этап есть, а места нет»; «не участвовал»
   отличается тем, что строки нет вовсе. Этап в зачёт не идёт (0 очков, вне статистики),
   но в протоколе пилот показывается там, где был бы по очкам за прогноз. */
const DQ_MARK = '<span class="dq-mark" title="Дисквалификация: этап не в зачёт">DQ</span>';

function coalMark(team) {
  // неразрывный пробел: значок не переносится на отдельную строку от названия команды
  return state.coalitions?.has(team) ? '&nbsp;<span class="coal-mark" title="В коалиции">🤝</span>' : '';
}

/* Штраф с листа Deductions: из очков он уже вычтен, метка идёт перед ними и показывает,
   сколько сняли; подсказка — причина из столбца Reason, пустой Reason оставляет метку без неё.
   Причина пишется руками, поэтому кавычки экранируем — иначе они рвут сам атрибут title. */
function penMark(t) {
  if (!t.penalty) return '';
  const why = [t.penaltyReason, t.penaltyRound != null ? `с ${fmtRoundNum(t.penaltyRound)} этапа` : '']
    .filter(Boolean).join(' · ').replace(/"/g, '&quot;');
  return `<span class="pen-mark"${why ? ` title="${why}"` : ''}>−${t.penalty}</span> `;
}

/* Производителя в листах пишут по-разному (Chevrolet, Chevy, Chv) — цвет бейджа
   и линии графика один и тот же, поэтому приводим написание к классу из CSS. */
const MFR_MATCH = [[/^(toy|tyt)/i, 'Toyota'], [/^(chev|chv)/i, 'Chevy'], [/^(ford|frd)/i, 'Ford']];
const mfrKey = mfr => MFR_MATCH.find(([re]) => re.test(mfr || ''))?.[1] || mfr;

// Номер машины пилота — в цветах из листа entries (bg/fg), без них — в цвете производителя
function carBadge(car, mfr) {
  if (!car || car === '—' || car === '-') return '<span class="muted">—</span>';
  const key = mfrKey(mfr);
  const c = state.carColors?.[car];
  const style = c ? ` style="background:#${c.bg};color:#${c.fg};border-color:#${c.bg}"` : '';
  // клик — карточка машины (зачёт владельцев)
  return `<span class="car-badge car-link${key ? ' ' + key : ''}"${style} title="Статистика машины #${car}" onclick="openCar('${car}')">${car}</span>`;
}

/* Ссылка на карточку пилота — одинаково во всех таблицах, сводных и протоколах */
/* Гостевая метка «(i)» в имени выводится не текстом, а серой меткой после ссылки.
   Зовут и как .map(driverLink) — тогда вторым и третьим аргументом приходят индекс и массив */
function driverLink(driver, mode, label) {
  if (!driver) return '—';
  if (typeof mode !== 'string') mode = null;
  if (typeof label !== 'string') label = driver;
  const arg = driver.replace(/'/g, "\\'").replace(/"/g, '&quot;');
  const name = label.replace(' (i)', '');
  return `<span class="driver-link" onclick="openDriver('${arg}'${mode ? `,'${mode}'` : ''})">${name}</span>`
    + (name !== label ? ' <span class="guest-mark" title="Гостевая заявка">(i)</span>' : '');
}

const MFR_SHORT = { Chevy: 'Chv', Ford: 'Frd', Toyota: 'Tyt' };

function mfrBadge(mfr) {
  if (!mfr || mfr === '-') return '';
  // на телефоне вместо полного названия — сокращение Chv / Frd / Tyt (переключает CSS)
  const key = mfrKey(mfr);
  const short = MFR_SHORT[key];
  return short
    ? `<span class="mfr-badge ${key}"><span class="mfr-full">${mfr}</span><span class="mfr-short">${short}</span></span>`
    : `<span class="mfr-badge ${key}">${mfr}</span>`;
}

/* Спойлер общих зачётов: первые SHOW_ROWS строк, остальное — по кнопке.
   При поиске показываем все найденные — прятать совпадения незачем. */
const spoilerRows = (key, rows, q) => q || state.showAll[key] ? rows : rows.slice(0, SHOW_ROWS);

function spoilerHtml(key, total) {
  if (total <= SHOW_ROWS) return '';
  return `<div class="pagination"><button class="page-btn" onclick="toggleShowAll('${key}')">`
    + `${state.showAll[key] ? 'Свернуть' : `Показать все (${total})`}</button></div>`;
}

function toggleShowAll(key) {
  state.showAll[key] = !state.showAll[key];
  const redraw = {
    teams: renderTeams, owners: renderOwners, gains: renderGainPivot, entries: renderEntries,
    teamPivot: renderTeamPivot, teamPosPivot: renderTeamPosPivot,
    'pivot-races': () => renderPivot('races'), 'pivot-quals': () => renderPivot('quals'),
    'golub-races': () => renderGolub('races'), 'golub-quals': () => renderGolub('quals'),
  };
  (redraw[key] || (() => renderTable(key)))();
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
  // заголовок группы столбцов (строка блоков в шапке) сам по себе ничего не сортирует
  if (th.colSpan > 1) return;

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

async function downloadXLSX(workbook, filename) {
  const buf = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const solidFill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + argb } });

// Те же пороги, что и у posClass в интерфейсе, но сплошной заливкой — как в официальном протоколе
function posFillHex(pos, maxPos) {
  if (pos === 1) return 'F1C40F';
  if (pos <= 5) return 'BFBFBF';
  if (pos <= 10) return 'D9A066';
  if (pos <= 20) return '8FD98F';
  if (pos <= (maxPos || 40)) return 'C9A0DC';
  return 'E68A90';
}

// Убирает полностью пустые столбцы и строки ЕЩЁ ДО записи в Excel — например, DR3/DR4/CAU
// в протоколах, где этих метрик просто нет (квала по метрике, дуэль и т.п.).
// Резать уже готовый лист через ws.spliceColumns нельзя: ExcelJS после этого не уменьшает
// фактическую ширину листа, оставляя пустые «хвостовые» ячейки без заголовка.
// cols — [[заголовок, row => значение], ...], rows — обычные объекты-строки.
const isBlankCell = v => v == null || v === '';

function dropEmptyCols(cols, rows) {
  return cols.filter(([, fn]) => rows.some(r => !isBlankCell(fn(r))));
}

function dropEmptyRows(cols, rows) {
  return rows.filter(r => cols.some(([, fn]) => !isBlankCell(fn(r))));
}

// Ширина столбца — по самому длинному значению в нём (как «автоподбор ширины» в Excel)
function autoSizeColumns(ws, colCount = ws.columnCount, { min = 4, max = 40, padding = 2 } = {}) {
  for (let i = 1; i <= colCount; i++) {
    const col = ws.getColumn(i);
    let maxLen = 0;
    col.eachCell({ includeEmpty: true }, cell => {
      const len = String(cell.value ?? '').length;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(max, Math.max(min, maxLen + padding));
  }
}

// Заливка по манёвру пилота — как в официальном протоколе этапа: цвет столбца зависит
// от того, что он значит (квала, дро́пы, штрафы), а не от значения в ячейке
const ROUND_COL_FILL = {
  'QL': 'F4B6B6', 'DR1': 'C6E2F5', 'DR2': 'C6E2F5', 'DR3': 'C6E2F5', 'DR4': 'C6E2F5',
  'CAU': 'F5C48A', 'MN': 'F5E6A8',
};
const MFR_FILL = { Toyota: 'F4B6B6', Chevy: 'F5E6A8', Ford: 'B6C6F0' };
const mfrFillHex = mfr => MFR_FILL[mfrKey(mfr)] || null;

// Год + серия — общая часть имени файла во всех выгрузках («2026 Open», «2026 Star»)
function exportSeriesLabel() {
  return `${state.year} ${DIVISIONS[state.division].label}`;
}

/* Простая выгрузка таблицы в Excel — из полных данных, а не из отрисованной таблицы:
   на экране строки урезаны поиском и пагинацией, в файл должен уйти весь набор целиком.
   cols — [[заголовок, row => значение]]. Протоколы с заливкой по местам собираются
   отдельно (exportProtocolXLSX, exportRoundXLSX) — там шапка та же, но своя раскраска. */
async function downloadTableXLSX(rows, cols, sheetName, filename) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(cols.map(([label]) => label));
  ws.getRow(1).eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = solidFill('1A1A1A');
    c.alignment = { horizontal: 'center' };
  });
  for (const r of rows) ws.addRow(cols.map(([, fn]) => fn(r)));
  autoSizeColumns(ws);
  await downloadXLSX(wb, filename);
}

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
// Смена дивизиона и сезона перезагружает страницу, но оставляет открытую вкладку
const activeTab = () => document.querySelector('.tab-btn.active')?.dataset.tab || 'races';

function switchDivision(name) {
  if (name === state.division || !DIVISIONS[name]) return;
  location.hash = `year=${state.year}&div=${name}&tab=${activeTab()}`;
  location.reload();
}

function switchYear(year) {
  year = Number(year);
  if (year === state.year || !SEASONS.includes(year)) return;
  location.hash = `year=${year}&div=${state.division}&tab=${activeTab()}`;
  location.reload();
}

// Star: коалиций нет, значит нет и зачёта независимых (там независимы все), и зачёта им. Голубочкина
function applyDivision() {
  const div = DIVISIONS[state.division];
  document.querySelectorAll('.div-btn').forEach(b =>
    b.classList.toggle('rtog-active', b.dataset.div === state.division));

  const hidden = [...(div.golub ? [] : ['golub']), ...(div.entries ? [] : ['entries'])];
  for (const tab of ['golub', 'entries']) {
    const on = !hidden.includes(tab);
    const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
    if (btn) btn.style.display = on ? '' : 'none';
    if (!on && document.querySelector('.tab-btn.active')?.dataset.tab === tab) switchTab('races');
  }
}

function initYearSelect() {
  const sel = document.getElementById('year-select');
  sel.innerHTML = YEARS.map(y => `<option value="${y}"${y === state.year ? ' selected' : ''}>${y}</option>`).join('');
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  // полоса табов прокручивается — активный на узком экране иначе остаётся за кадром
  document.querySelector(`.tab-btn[data-tab="${name}"]`)
    ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  writeHash();
  // данные вкладки грузим при первом открытии, а не все сразу на старте
  if (state.kpi) ensureTab(name).catch(err => console.error(err));
}

/* ── Состояние в адресной строке: #tab=rounds&round=8&view=qual ── */
function writeHash() {
  const tab = document.querySelector('.tab-btn.active')?.dataset.tab || 'races';
  const parts = [`year=${state.year}`, `div=${state.division}`, `tab=${tab}`];
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
  if (tab && document.getElementById(`tab-${tab}`) && btn && btn.style.display !== 'none') switchTab(tab);

  // этап из ссылки: протоколы к этому моменту могли ещё не грузиться
  const round = p.get('round');
  if (!round) return;
  ensureTab('rounds').then(() => {
    const sel = document.getElementById('round-select');
    if (!sel || ![...sel.options].some(o => o.value === round)) return;
    sel.value = round;
    const view = p.get('view');
    if (view) roundView = view;
    onRoundChange();
  }).catch(err => console.error(err));
}
