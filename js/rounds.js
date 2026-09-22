/* Вкладка «По этапам»: результаты и зачёты после этапа */

/* Лучшие значения этапа (для подсветки) считает база: у каждой строки протокола
   в hl — ключи ячеек с лучшим значением. Подсвечиваются только колонки с флагом hl. */
const isHighlighted = (col, r) => !!col.hl && Array.isArray(r.hl) && r.hl.includes(col.key);

function renderRoundTable(containerId, rows, cols) {
  const wrap = document.getElementById(containerId);
  if (!rows.length) { wrap.innerHTML = '<div class="round-empty">Нет данных</div>'; return; }

  let html = '<div class="table-scroll"><table class="round-table" data-sort="auto"><thead><tr>';
  for (const { label, cls, title } of cols)
    html += `<th class="${cls || ''}"${title ? ` title="${title}"` : ''}>${label}</th>`;
  html += '</tr></thead><tbody>';

  for (const r of rows) {
    html += '<tr>';
    for (const col of cols) {
      const { key, cls, fmt } = col;
      const v = r[key];
      const display = fmt ? fmt(v, r) : (v == null ? '—' : v);
      const highlight = isHighlighted(col, r);
      const cellCls = [cls || '', highlight ? 'hl' : ''].filter(Boolean).join(' ');
      html += `<td class="${cellCls}">${display}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  wrap.innerHTML = html;
}

/* ── Зачёт владельцев (п. 9.6): очки как у пилотов, но принадлежат номеру машины.
   Гость очков себе не берёт, а машине приносит (#43 набран одними гостями).
   П. 4.9.5 (смена производителя обнуляет очки машины) в данных не подтверждается: все «смены»
   оказались разовыми гостевыми строками и опечатками с потерянным ведущим нулём. ── */

const ROUND_VIEWS = ['race', 'qual', 'duel1', 'duel2', 'st-drivers', 'st-teams', 'st-owners', 'metric-next'];
const ROUND_VIEW_LABEL = {
  race: 'Race', qual: 'Qual', duel1: 'Duel 1', duel2: 'Duel 2',
  'st-drivers': 'Standings', 'st-teams': 'Teams', 'st-owners': 'Owners', 'metric-next': 'Next metric',
};
let roundView = 'race';

// Название трассы без номера этапа: state.roundNames хранит «26 · Daytona»
const trackNameOf = roundNum => (state.roundNames[String(roundNum)] || '').split(' · ')[1] || '';

// «2026 Open - Daytona - Race»
const roundExportName = roundNum => `${exportSeriesLabel()} - ${trackNameOf(roundNum)} - ${ROUND_VIEW_LABEL[roundView]}`;

// Полные данные текущего вида таблицы этапа — для выгрузки в обход поиска на экране
let roundExport = null;

// roundExport.cols — либо готовые пары [заголовок, row => значение] (зачёты после этапа),
// либо «сырые» определения колонок таблицы этапа ({key, label, maxKey, group, …}) —
// вторые нужны как есть для подсветки лучших значений при экспорте в Excel.
const roundColsToPairs = cols => cols.map(c => Array.isArray(c) ? c : [c.label, r => r[c.key] ?? '']);

// Протокол этапа в .xlsx — заливка столбцов по типу метрики (квала, дропы, штрафы),
// как в официальном протоколе; ячейка, подсвеченная на экране как лучшее значение
// (жёлтый текст), заливается жёлтым и в Excel — вместо обычного цвета своего столбца.
const ROUND_HIGHLIGHT_FILL = 'F5E6A8';

async function exportRoundXLSX() {
  if (!roundExport) return;
  const { cols, rows, filename } = roundExport;
  const isRaw = cols.length > 0 && !Array.isArray(cols[0]);
  let pairs = roundColsToPairs(cols);

  // Пустые столбцы (например, DR3/DR4 в квале по метрике, где их просто нет) убираем
  // до записи в лист — сама подсветку лучших значений считаем по полным исходным rows
  const keep = pairs.map(([, fn]) => rows.some(r => !isBlankCell(fn(r))));
  const keptCols = isRaw ? cols.filter((_, i) => keep[i]) : cols;
  pairs = pairs.filter((_, i) => keep[i]);
  const keptRows = dropEmptyRows(pairs, rows);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Round');

  ws.addRow(pairs.map(([label]) => label));
  ws.getRow(1).eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = solidFill('1A1A1A');
    c.alignment = { horizontal: 'center' };
  });

  for (const r of keptRows) {
    const row = ws.addRow(pairs.map(([, fn]) => fn(r)));
    row.eachCell(cell => cell.alignment = { horizontal: 'center' });
    if (isRaw) keptCols.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      const hex = isHighlighted(col, r) ? ROUND_HIGHLIGHT_FILL
        : col.key === 'M.' ? mfrFillHex(r['M.'])
          : ROUND_COL_FILL[col.key];
      if (hex) cell.fill = solidFill(hex);
    });
  }

  autoSizeColumns(ws);
  downloadXLSX(wb, `${filename}.xlsx`);
}

function setRoundView(view) {
  roundView = view;
  // только свой переключатель: такие же кнопки есть во вкладке GOLUBOCHKIN
  document.querySelectorAll('#round-toggle .rtog-btn').forEach(b => b.classList.toggle('rtog-active', b.dataset.view === view));
  onRoundChange();
}

function renderRoundToggle(isRound1) {
  const btns = isRound1
    ? [['qual', 'Квалификация'], ['duel1', 'Дуэль 1'], ['duel2', 'Дуэль 2'], ['race', 'Гонка']]
    : [['race', 'Гонка'], ['qual', 'Квалификация']];
  btns.push(['st-drivers', 'Личный'], ['st-teams', 'Командный'], ['st-owners', 'Владельцы'], ['metric-next', 'Метрика на след. этап']);
  document.getElementById('round-toggle').innerHTML = btns.map(([v, label]) =>
    `<button class="rtog-btn${roundView === v ? ' rtog-active' : ''}" data-view="${v}" onclick="setRoundView('${v}')">${label}</button>`
  ).join('');
}

/* ── Зачёты по состоянию после этапа ── */
function deltaCell(prevRank, rank) {
  if (prevRank == null) return '<span class="muted" title="Новый в зачёте">•</span>';
  const d = prevRank - rank;
  if (d === 0) return '<span class="muted">—</span>';
  return `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`;
}

// Поиск по вкладке: сужает и протокол этапа, и зачёты после него
const roundHit = (...fields) => hit(state.roundFilter, ...fields);

function filterRound(val) {
  state.roundFilter = val;
  onRoundChange();
}

const roundArgs = (roundNum, extra) => ({ season: state.year, division: state.division, round: roundNum, ...extra });
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const jsArg = s => s.replace(/'/g, "\\'").replace(/"/g, '&quot;');

// П. 8.8: метрика участников на следующий этап — считает база (api.round_metric)
async function renderRoundMetric(roundNum) {
  const { field, rows: full } = await rpc('round_metric', roundArgs(roundNum), state.fresh);
  const noteText = m => m.carNote ? `Под этим номером позже выступал ${m.carNote} — мог не подать прогноз под этим номером` : '';

  roundExport = { rows: full, filename: roundExportName(roundNum), cols: [
    ['#', m => full.indexOf(m) + 1], ['Участник', m => m.driver], ['Команда', m => m.team], ['Номер', m => m.car],
    ['Место в гонке', m => m.pos ?? m.place], ['Место в чемпионате', m => m.champRank],
    ['Место машины у владельцев', m => m.ownerRank], ['Метрика', m => m.metric], ['Примечание', noteText],
  ] };
  const body = full.map((m, i) => [i + 1, m]).filter(([, m]) => roundHit(m.driver, m.team, m.car))
    .map(([place, m]) => `<tr class="${place <= 3 ? 'rank-' + place : ''}">
  <td class="r"><span class="pos-badge">${place}</span></td>
  <td><strong class="driver-link" onclick="openDriver('${jsArg(m.driver)}')">${m.driver}</strong></td>
  <td class="team-text">${m.team}${coalMark(m.team)}</td>
  <td><strong>#${m.car}</strong>${m.carNote ? ` <span class="hl coal-mark" title="${escAttr(noteText(m))}">*</span>` : ''}</td>
  <td class="r">${m.pos ?? `<span class="muted" title="Не прошёл квалификацию или не подавал прогноз — место ${m.place}">${m.place}</span>`}</td>
  <td class="r">${m.champRank}</td>
  <td class="r">${m.ownerRank}</td>
  <td class="r"><strong>${Number(m.metric).toFixed(2)}</strong></td>
</tr>`).join('');
  document.getElementById('round-table').innerHTML = `<div class="table-scroll"><table class="standings-table" data-sort="auto"><thead><tr>
  <th class="r w-36">#</th><th>Участник</th><th>Команда</th><th>Номер</th>
  <th class="r" title="Не прошедшие квалификацию и не подававшие прогноз — место ${field + 1}">Место в гонке</th>
  <th class="r" title="Место в личном зачёте после этапа (п. 8.8.2–8.8.3)">Место в чемпионате</th>
  <th class="r" title="Место машины в зачёте владельцев после этапа">Место машины у владельцев</th>
  <th class="r" title="50% места в гонке + 25% места в чемпионате + 25% места машины у владельцев; меньше — лучше">Метрика</th>
</tr></thead><tbody>${body}</tbody></table></div>`;
}

// kind: 'st-drivers' | 'st-teams' | 'st-owners' — зачёт по состоянию после этапа (api.round_standings)
async function renderRoundStandings(kind, roundNum) {
  const apiKind = { 'st-drivers': 'drivers', 'st-teams': 'teams', 'st-owners': 'owners' }[kind];
  const { rows: full, prevRank: prevPos } = await rpc('round_standings', roundArgs(roundNum, { kind: apiKind }), state.fresh);

  let head, body;
  if (kind === 'st-teams') {
    roundExport = { rows: full, filename: roundExportName(roundNum), cols: [
      ['#', t => t.rank], ['Команда', t => t.team], ['Очки', t => t.total],
      ['Топ-10', t => t.bestPositions.slice(0, 10).join(' · ')],
    ] };
    head = '<th>Команда</th><th class="r">Очки</th><th class="r" title="Десять лучших финишей пилотов команды">Топ-10</th>';
    body = full.filter(t => roundHit(t.team, ...t.drivers))
      .map(t => [t.rank, deltaCell(prevPos[t.team], t.rank),
    `<td><strong>${teamLink(t.team)}</strong>${coalMark(t.team)}</td>
   <td class="r" title="${scorersTooltip(t)}">${penMark(t)}<strong>${t.total}</strong></td>
   <td class="r muted">${t.bestPositions.slice(0, 10).join(' · ') || '—'}</td>`]);
  } else if (kind === 'st-owners') {
    roundExport = { rows: full, filename: roundExportName(roundNum), cols: [
      ['#', o => o.rank], ['Номер', o => o.car], ['Пилоты', o => o.drivers.join(' · ')],
      ['Очки', o => o.total], ['Топ-5', o => o.top5.join(' · ')],
    ] };
    head = '<th>Номер</th><th>Пилоты</th><th class="r">Очки</th><th class="r" title="Пять лучших финишей">Топ-5</th>';
    body = full.filter(o => roundHit(o.car, ...o.drivers))
      .map(o => [o.rank, deltaCell(prevPos[o.car], o.rank),
    `<td><strong>#${o.car}</strong></td>
   <td class="team-text">${[...o.drivers].sort().join(' · ')}</td>
   <td class="r"><strong>${o.total}</strong></td>
   <td class="r muted">${o.top5.join(' · ') || '—'}</td>`]);
  } else {
    roundExport = { rows: full, filename: roundExportName(roundNum), cols: [
      ['#', s => s.rank], ['Гонщик', s => s.driver], ['Команда', s => s.team],
      ['Авт.', s => s.mfr], ['Очки', s => s.total], ['Победы', s => s.wins],
      ['Топ-5', s => s.top5.join(' · ')],
    ] };
    head = '<th>Гонщик</th><th>Команда</th><th>Авт.</th><th class="r">Очки</th><th class="r">Победы</th>'
      + '<th class="r" title="Пять лучших финишей">Топ-5</th>';
    body = full.filter(s => roundHit(s.driver, s.team))
      .map(s => [s.rank, deltaCell(prevPos[s.driver], s.rank),
    `<td><strong class="driver-link" onclick="openDriver('${jsArg(s.driver)}')">${s.driver}</strong></td>
   <td class="team-text">${s.team}${coalMark(s.team)}</td>
   <td>${mfrBadge(s.mfr)}</td>
   <td class="r"><strong>${s.total}</strong></td>
   <td class="r">${s.wins > 0 ? `<strong class="win">${s.wins}</strong>` : '<span class="muted">—</span>'}</td>
   <td class="r muted">${s.top5.join(' · ') || '—'}</td>`]);
  }

  document.getElementById('round-table').innerHTML = `<div class="table-scroll"><table class="standings-table" data-sort="auto"><thead><tr>
  <th class="r w-36">#</th>
  <th class="r" title="Изменение позиции к прошлому этапу">±</th>${head}
</tr></thead><tbody>` +
    body.map(([rank, delta, cells]) => `<tr class="${rank != null && rank <= 3 ? 'rank-' + rank : ''}">
  <td class="r"><span class="pos-badge">${rank ?? '—'}</span></td>
  <td class="r">${delta}</td>${cells}
</tr>`).join('') +
    '</tbody></table></div>';
}

async function onRoundChange() {
  const val = document.getElementById('round-select').value;
  const roundNum = parseFloat(val);
  const name = state.roundNames[val] || val;
  const isRound1 = roundNum === 1;

  // Неизвестный вид (например, из старой ссылки) и дуэли вне первого этапа — назад к гонке
  if (!ROUND_VIEWS.includes(roundView)) roundView = 'race';
  if (!isRound1 && (roundView === 'duel1' || roundView === 'duel2')) roundView = 'race';
  renderRoundToggle(isRound1);
  writeHash();

  const title = document.getElementById('round-table-title');
  if (roundView.startsWith('st-')) {
    const titles = { 'st-drivers': 'Личный зачёт', 'st-teams': 'Командный зачёт', 'st-owners': 'Зачёт владельцев' };
    title.textContent = `${titles[roundView]} после этапа — ${name}`;
    return renderRoundStandings(roundView, roundNum);
  }
  if (roundView === 'metric-next') {
    title.textContent = `Метрика на следующий этап — после этапа ${name}`;
    return renderRoundMetric(roundNum);
  }

  /* Протокол этапа считает база (api.round_protocol): порядок с дисквалифицированными
     по очкам прогноза, очки NASCAR, «прошёл дальше», ± квала→гонка и лучшие значения
     (в квале по метрике лучшие очки — наименьшие, это тоже учтено там). */
  const { rows } = await rpc('round_protocol', roundArgs(roundNum, { view: roundView }), state.fresh);
  const hitRow = r => roundHit(r['Driver'], r['Team'], r['#']);
  const madeFmt = (v, r) => v == null ? DQ_MARK : `<span class="${r.made ? 'up' : 'down'}">${v}</span>`;
  const pointsCol = { key: 'Points', label: 'Очки', cls: 'r', fmt: v => `<strong>${v ?? '—'}</strong>`, hl: true };
  const nascarCol = { key: 'nascar', label: 'NASCAR', cls: 'r', fmt: v => `<strong class="nascar-pts">${v}</strong>` };
  const drCols = ['DR1', 'DR2', 'DR3', 'DR4'].map(k => ({ key: k, label: k, cls: 'r', fmt: v => v ?? '—', hl: true }));
  const baseCols = [
    { key: '#', label: '#', cls: 'r' },
    { key: 'Driver', label: 'Пилот' },
    { key: 'Team', label: 'Команда', fmt: v => `<span class="team-text">${v || '—'}${coalMark(v)}</span>` },
    { key: 'M.', label: 'Авт.', fmt: v => mfrBadge(v) },
  ];

  let cols;
  if (roundView === 'race') {
    title.textContent = `Гонка — ${name}`;
    cols = [
      { key: 'Pos.', label: 'Поз.', cls: 'r', fmt: v => v == null ? DQ_MARK : v, hl: true },
      { key: 'delta', label: '±', cls: 'r', fmt: v => v == null ? '<span class="muted">—</span>'
          : v === 0 ? '<span class="muted">0</span>'
            : `<span class="${v > 0 ? 'up' : 'down'}">${v > 0 ? '+' : ''}${v}</span>` },
      ...baseCols,
      { key: 'QL', label: 'QL', cls: 'r', fmt: v => v ?? '—', hl: true },
      ...drCols,
      ...['CAU', 'RET', 'MN'].map(k => ({ key: k, label: k, cls: 'r', fmt: v => v ?? '—', hl: true })),
      pointsCol, nascarCol,
    ];
  } else {
    title.textContent = `${roundView === 'qual' ? 'Квалификация' : roundView === 'duel1' ? 'Дуэль 1' : 'Дуэль 2'} — ${name}`;
    cols = [{ key: 'Pos.', label: 'Поз.', cls: 'r', fmt: madeFmt }, ...baseCols, ...drCols, pointsCol, nascarCol];
  }
  roundExport = { rows, filename: roundExportName(roundNum), cols: cols.filter(c => c.key !== 'nascar' && c.key !== 'delta') };
  renderRoundTable('round-table', rows.filter(hitRow), cols);
}

function initRoundView() {
  const sel = document.getElementById('round-select');
  // Этапы, по которым есть протокол, — из сводки сезона; этап 0 (незачётный) тоже:
  // его протокол смотреть можно и нужно. Дуэли выбираются внутри первого этапа.
  const options = (state.protocolRounds || [])
    .map(n => `<option value="${n}">${state.roundNames[String(n)] || n}</option>`);
  sel.innerHTML = options.join('');
  if (options.length) onRoundChange();
}
