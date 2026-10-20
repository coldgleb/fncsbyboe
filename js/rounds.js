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
    // участник Чейза (этапы с 27-го) — зелёная подсветка строки
    html += r.chase ? '<tr class="row-playoff">' : '<tr>';
    for (const col of cols) {
      const { key, cls, fmt, cellCls } = col;
      const v = r[key];
      const display = fmt ? fmt(v, r) : (v == null ? '—' : v);
      const highlight = isHighlighted(col, r);
      // cellCls — класс ячейки по строке (номер машины в Чейзе владельцев)
      const tdCls = [cls || '', highlight ? 'hl' : '', cellCls ? cellCls(r).trim() : ''].filter(Boolean).join(' ');
      html += `<td class="${tdCls}">${display}</td>`;
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

const ROUND_VIEWS = ['race', 'qual', 'duel1', 'duel2', 'round-teams', 'metric-next'];
const ROUND_VIEW_LABEL = {
  race: 'Race', qual: 'Qual', duel1: 'Duel 1', duel2: 'Duel 2',
  'metric-next': 'Next metric',
  'round-teams': 'Teams round',
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
  btns.push(['round-teams', 'Команды на этапе'], ['metric-next', 'Метрика на след. этап']);
  document.getElementById('round-toggle').innerHTML = btns.map(([v, label]) =>
    `<button class="rtog-btn${roundView === v ? ' rtog-active' : ''}" data-view="${v}" onclick="setRoundView('${v}')">${label}</button>`
  ).join('');
}

/* Изменение места к прошлому срезу (нужно и личному зачёту в drivers.js) */
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
  const { field, noStartMax, rows: full } = await rpc('round_metric', roundArgs(roundNum), state.fresh);
  const noteText = m => m.carNote ? `Под этим номером позже выступал ${m.carNote} — мог не подать прогноз под этим номером` : '';

  roundExport = { rows: full, filename: roundExportName(roundNum), cols: [
    ['#', m => full.indexOf(m) + 1], ['Участник', m => m.driver], ['Команда', m => m.team], ['Номер', m => m.car],
    ['Место в гонке', m => m.pos ?? m.place], ['Место в чемпионате', m => m.champRank],
    ['Место машины у владельцев', m => m.ownerRank], ['Метрика', m => m.metric], ['Примечание', noteText],
  ] };
  const body = full.map((m, i) => [i + 1, m]).filter(([, m]) => roundHit(m.driver, m.team, m.car))
    .map(([place, m]) => `<tr class="${place <= 3 ? 'rank-' + place : ''}${m.chase ? ' row-playoff' : ''}">
  <td class="r"><span class="pos-badge">${place}</span></td>
  <td><strong>${driverLink(m.driver)}</strong></td>
  <td class="team-text hide-sm">${teamLink(m.team)}${coalMark(m.team)}</td>
  <td class="c${carCell(m.car, roundNum > CHASE_START)}">${carBadge(m.car, state.carOf?.[m.driver]?.mfr)}${m.carNote ? ` <span class="hl coal-mark" title="${escAttr(noteText(m))}">*</span>` : ''}</td>
  <td class="r hide-sm">${m.pos ?? `<span class="muted" title="${m.place === field + 1 ? 'Подал прогноз, но не прошёл квалификацию' : 'Не подавал прогноз'} — место ${m.place}">${m.place}</span>`}</td>
  <td class="r hide-sm">${m.champRank}</td>
  <td class="r hide-sm">${m.ownerRank}</td>
  <td class="r"><strong>${Number(m.metric).toFixed(2)}</strong></td>
</tr>`).join('');
  document.getElementById('round-table').innerHTML = `<div class="table-scroll"><table class="standings-table" data-sort="auto"><thead><tr>
  <th class="r w-36"></th><th>Участник</th><th class="hide-sm">Команда</th><th class="c">Номер</th>
  <th class="r hide-sm" title="Не прошедшие квалификацию — место ${field + 1}, не подававшие прогноз — ${noStartMax}">Место в гонке</th>
  <th class="r hide-sm" title="Место в личном зачёте после этапа (п. 8.8.2–8.8.3)">Место в чемпионате</th>
  <th class="r hide-sm" title="Место машины в зачёте владельцев после этапа">Место машины у владельцев</th>
  <th class="r" title="50% места в гонке + 25% места в чемпионате + 25% места машины у владельцев; меньше — лучше">Метрика</th>
</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* Команды на этапе: места всех участников команды в гонке и в квалификации, очки NASCAR
   всех вместе и в зачёт — два лучших результата (считает api.round_teams) */
function roundTeamsTableHtml(list) {
  const rows = list.filter(t => teamHit(state.roundFilter, t.team, ...t.members.map(m => m.driver)));
  if (!rows.length) return '<div class="round-empty">Нет данных</div>';
  // гость — «(i)» в имени (одни гостевые заявки) или метка у гостевой заявки своего пилота
  const guestMark = m => m.guest && !m.driver.includes('(i)') ? ' <span class="guest-mark" title="Гостевая заявка">(i)</span>' : '';
  const member = m => `<span class="team-member${m.counted ? ' counted' : ''}" title="${escAttr(
    `${m.driver}: ${m.pos == null ? 'DQ' : 'P' + m.pos}, ${m.pts} очк. NASCAR, ${m.points ?? '—'} первичных${m.counted ? ' — в зачёт' : ''}${m.guest ? ' (гость)' : ''}`)}">`
    + (m.pos == null ? DQ_MARK : `<span class="pos-badge">${m.pos}</span>`)
    + ` <span class="team-member-name">${driverLink(m.driver)}${guestMark(m)}</span></span>`;
  return `<div class="table-scroll"><table class="standings-table" data-sort="auto"><thead><tr>
  <th class="r w-36"></th><th>Команда</th>
  <th title="Места участников команды; зелёным — два зачётных результата">Участники</th>
  <th class="r" title="Первичные очки — очки за прогноз (Points) двух зачётных результатов команды">Первичные</th>
  <th class="r" title="Очки NASCAR всех участников команды">Всего</th>
  <th class="r" title="Очки NASCAR двух лучших результатов команды — столько идёт в командный зачёт">В зачёт</th>
</tr></thead><tbody>${rows.map(t => `<tr class="${t.rank <= 3 ? 'rank-' + t.rank : ''}">
  <td class="r"><span class="pos-badge">${t.rank}</span></td>
  <td><strong>${teamLink(t.team)}</strong>${coalMark(t.team)}</td>
  <td><div class="team-members">${t.members.map(member).join('')}</div></td>
  <td class="r">${t.points}</td>
  <td class="r">${t.total}</td>
  <td class="r"><strong class="nascar-pts">${t.counted}</strong></td>
</tr>`).join('')}</tbody></table></div>`;
}

async function renderRoundTeams(roundNum) {
  const { race, qual } = await rpc('round_teams', roundArgs(roundNum), state.fresh);
  const flat = (list, label) => list.map(t => ({ ...t, session: label }));
  const full = [...flat(race, 'Гонка'), ...flat(qual || [], 'Квалификация')];
  const posOf = m => (m.pos == null ? 'DQ' : 'P' + m.pos);
  roundExport = { rows: full, filename: roundExportName(roundNum), cols: [
    ['Сессия', t => t.session], ['#', t => t.rank], ['Команда', t => t.team],
    ['Участники', t => t.members.map(m => `${posOf(m)} ${m.driver}${m.guest && !m.driver.includes('(i)') ? ' (i)' : ''}${m.counted ? ' *' : ''}`).join(' · ')],
    ['Первичные', t => t.points], ['Всего', t => t.total], ['В зачёт', t => t.counted],
  ] };
  document.getElementById('round-table').innerHTML =
    `<h4 class="round-subtitle">Гонка</h4>${roundTeamsTableHtml(race)}`
    // квала по метрике (без DR) мест по прогнозу не даёт — её таблицу не показываем
    + (qual ? `<h4 class="round-subtitle">Квалификация</h4>${roundTeamsTableHtml(qual)}` : '');
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
  if (roundView === 'round-teams') {
    title.textContent = `Команды на этапе — ${name}`;
    return renderRoundTeams(roundNum);
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
  const madeFmt = (v, r) => v == null ? DQ_MARK
    : `<span class="pos-badge ${r.made ? 'made' : 'missed'}">${v}</span>`;
  const pointsCol = { key: 'Points', label: 'Очки', cls: 'r', fmt: v => `<strong>${v ?? '—'}</strong>`, hl: true };
  const nascarCol = { key: 'nascar', label: 'NASCAR', cls: 'r', fmt: v => `<strong class="nascar-pts">${v}</strong>` };
  // на телефоне в протоколе остаются Поз. · # · Пилот · Команда · Очки · NASCAR (hide-sm — в style.css)
  const drCols = ['DR1', 'DR2', 'DR3', 'DR4'].map(k => ({ key: k, label: k, cls: 'r hide-sm', fmt: v => v ?? '—', hl: true }));
  const baseCols = [
    { key: '#', label: '#', cls: 'c', cellCls: r => carCell(r['#'], roundNum > CHASE_START), fmt: (v, r) => carBadge(v, r['M.']) },
    // гостевая заявка пилота, у которого есть и свои, — «(i)» в имени у него нет, ставим метку
    { key: 'Driver', label: 'Пилот', cls: 'sticky-col', fmt: (v, r) => `<strong>${driverLink(v)}</strong>`
      + (r.guest && !v.includes('(i)') ? ' <span class="guest-mark" title="Гостевая заявка">(i)</span>' : '') },
    { key: 'Team', label: 'Команда', fmt: v => `<span class="team-text">${teamLink(v)}${coalMark(v)}</span>` },
    { key: 'M.', label: 'Авт.', cls: 'hide-sm', fmt: v => mfrBadge(v) },
  ];

  let cols;
  if (roundView === 'race') {
    title.textContent = `Гонка — ${name}`;
    cols = [
      { key: 'Pos.', label: 'Поз.', cls: 'r', fmt: v => v == null ? DQ_MARK : `<span class="pos-badge">${v}</span>`, hl: true },
      { key: 'delta', label: '±', cls: 'r hide-sm', fmt: v => v == null ? '<span class="muted">—</span>'
          : v === 0 ? '<span class="muted">0</span>'
            : `<span class="${v > 0 ? 'up' : 'down'}">${v > 0 ? '+' : ''}${v}</span>` },
      ...baseCols,
      { key: 'QL', label: 'QL', cls: 'r hide-sm', fmt: v => v ?? '—', hl: true },
      ...drCols,
      ...['CAU', 'RET', 'MN'].map(k => ({ key: k, label: k, cls: 'r hide-sm', fmt: v => v ?? '—', hl: true })),
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
  // по умолчанию — последний проведённый этап (последняя гонка; гонок нет — последний протокол)
  const lastRace = state.races.rounds.filter(r => !SPRINT_ROUNDS.has(r)).pop();
  sel.value = String(lastRace ?? state.protocolRounds?.at(-1) ?? '');
  if (!sel.value && options.length) sel.selectedIndex = 0;
  if (options.length) onRoundChange();
}
