/* Вкладка «По этапам»: результаты и зачёты после этапа */

// Пороги для подсветки «лучшего значения» — общие и для экрана, и для экспорта,
// поэтому считаются по allRows (полному протоколу), а не урезанным поиском rows.
function roundHighlightContext(allRows, cols) {
  const colMax = {}, colMin = {};
  for (const col of cols) {
    const vals = col.maxKey || col.minKey
      ? allRows.map(r => r[col.maxKey || col.minKey]).filter(v => v != null && isFinite(v))
      : [];
    if (col.maxKey) colMax[col.maxKey + col.label] = vals.length ? Math.max(...vals) : null;
    if (col.minKey) colMin[col.minKey + col.label] = vals.length ? Math.min(...vals) : null;
  }

  const groupThresh = {};
  const groupDefs = {};
  for (const col of cols) {
    if (!col.group) continue;
    if (!groupDefs[col.group]) groupDefs[col.group] = { top: col.groupTop || 1, vals: [] };
    for (const r of allRows) {
      const v = r[col.key];
      if (v != null && isFinite(v)) groupDefs[col.group].vals.push(v);
    }
  }
  for (const [grp, { top, vals }] of Object.entries(groupDefs)) {
    const uniq = [...new Set(vals)].sort((a, b) => b - a);
    groupThresh[grp] = uniq.length >= top ? uniq[top - 1] : (uniq[uniq.length - 1] ?? null);
  }

  return { colMax, colMin, groupThresh };
}

function isRoundCellHighlighted(col, r, { colMax, colMin, groupThresh }) {
  if (col.maxKey) {
    const mx = colMax[col.maxKey + col.label];
    return mx != null && r[col.maxKey] != null && r[col.maxKey] === mx;
  }
  if (col.minKey) {
    const mn = colMin[col.minKey + col.label];
    return mn != null && r[col.minKey] != null && r[col.minKey] === mn;
  }
  if (col.group) {
    const thresh = groupThresh[col.group];
    const v = r[col.key];
    return thresh != null && v != null && v >= thresh;
  }
  return false;
}

// allRows — полный протокол этапа: подсветку лучших значений поиск сужать не должен
function renderRoundTable(containerId, rows, cols, allRows = rows) {
  const wrap = document.getElementById(containerId);
  if (!rows.length) { wrap.innerHTML = '<div class="round-empty">Нет данных</div>'; return; }

  const ctx = roundHighlightContext(allRows, cols);

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
      const highlight = isRoundCellHighlighted(col, r, ctx);
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
  const ctx = isRaw ? roundHighlightContext(rows, keptCols) : null;

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
      const hex = isRoundCellHighlighted(col, r, ctx) ? ROUND_HIGHLIGHT_FILL
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

// Зачёт владельцев после этапа n (дуэли — часть своего этапа), после 26 этапа — с Чейзом
function ownersAfter(n) {
  const rows = state.races.rowsWithDuel.filter(r => r['Round'] < n + 1);
  return n > CHASE_START ? computeChaseOwnerStandings(rows) : computeOwnerStandings(rows);
}

// П. 8.8: метрика участников на следующий этап (стартовый порядок при отмене квалификации)
function renderRoundMetric(roundNum) {
  const field = state.roundMaxPos[roundNum] || 40;
  const race = state.races.rowsWithDuel.filter(r => r['Round'] < roundNum + 1);
  const quals = state.quals.rows.filter(r => r['Round'] < roundNum + 1);
  const champ = metricChampRanks(roundNum > CHASE_START ? computeChaseStandings(race) : computeStandings(race), quals);
  const owners = ownersAfter(roundNum);
  const ownerRank = Object.fromEntries(owners.map(o => [o.car, o.rank]));

  // Машина и команда участника — по его последней строке; последний участник под каждым номером
  const last = {}, lastOfCar = {};
  for (const r of [...quals, ...race]) {
    const d = r['Driver'], car = r['#'], rnd = r['Round'];
    if (!d || !car || car === '-' || rnd == null) continue;
    if (!(last[d]?.rnd > rnd)) last[d] = { rnd, car: String(car), team: r['Team'] && r['Team'] !== '—' ? r['Team'] : '—' };
    if (!(lastOfCar[car]?.rnd > rnd)) lastOfCar[car] = { rnd, driver: d };
  }
  const posOf = Object.fromEntries(state.races.rows
    .filter(r => parseFloat(r['Round']) === roundNum && r['Pos.'] != null).map(r => [r['Driver'], r['Pos.']]));

  const full = computeNextMetric(Object.keys(champ).map(driver => {
    const { car = '—', team = '—' } = last[driver] || {};
    const pos = posOf[driver] ?? null;
    const other = lastOfCar[car]?.driver;
    return { driver, team, car, pos, place: pos ?? field + 1, champRank: champ[driver],
      ownerRank: ownerRank[car] ?? owners.length + 1, carNote: other && other !== driver ? other : null };
  }));
  const noteText = m => m.carNote ? `Под этим номером позже выступал ${m.carNote} — мог не подать прогноз под этим номером` : '';

  roundExport = { rows: full, filename: roundExportName(roundNum), cols: [
    ['#', m => full.indexOf(m) + 1], ['Участник', m => m.driver], ['Команда', m => m.team], ['Номер', m => m.car],
    ['Место в гонке', m => m.pos ?? m.place], ['Место в чемпионате', m => m.champRank],
    ['Место машины у владельцев', m => m.ownerRank], ['Метрика', m => m.metric], ['Примечание', noteText],
  ] };
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const body = full.map((m, i) => [i + 1, m]).filter(([, m]) => roundHit(m.driver, m.team, m.car))
    .map(([place, m]) => `<tr class="${place <= 3 ? 'rank-' + place : ''}">
  <td class="r"><span class="pos-badge">${place}</span></td>
  <td><strong class="driver-link" onclick="openDriver('${m.driver.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')">${m.driver}</strong></td>
  <td class="team-text">${m.team}${coalMark(m.team)}</td>
  <td><strong>#${m.car}</strong>${m.carNote ? ` <span class="hl coal-mark" title="${esc(noteText(m))}">*</span>` : ''}</td>
  <td class="r">${m.pos ?? `<span class="muted" title="Не прошёл квалификацию или не подавал прогноз — место ${m.place}">${m.place}</span>`}</td>
  <td class="r">${m.champRank}</td>
  <td class="r">${m.ownerRank}</td>
  <td class="r"><strong>${m.metric.toFixed(2)}</strong></td>
</tr>`).join('');
  document.getElementById('round-table').innerHTML = `<div class="table-scroll"><table class="standings-table" data-sort="auto"><thead><tr>
  <th class="r w-36">#</th><th>Участник</th><th>Команда</th><th>Номер</th>
  <th class="r" title="Не прошедшие квалификацию и не подававшие прогноз — место ${field + 1}">Место в гонке</th>
  <th class="r" title="Место в личном зачёте после этапа (п. 8.8.2–8.8.3)">Место в чемпионате</th>
  <th class="r" title="Место машины в зачёте владельцев после этапа">Место машины у владельцев</th>
  <th class="r" title="50% места в гонке + 25% места в чемпионате + 25% места машины у владельцев; меньше — лучше">Метрика</th>
</tr></thead><tbody>${body}</tbody></table></div>`;
}

// kind: 'st-drivers' | 'st-teams' | 'st-owners' — зачёт по состоянию после этапа
function renderRoundStandings(kind, roundNum) {
  // Дуэли (1.1/1.2) относятся к своему этапу, поэтому граница — до следующего целого
  const upTo = n => state.races.rowsWithDuel.filter(r => r['Round'] < n + 1);
  const prevRound = Math.max(...state.races.rounds.filter(r => r < roundNum), 0);
  const rowsNow = upTo(roundNum);
  const rowsPrev = prevRound ? upTo(prevRound) : [];

  let head, body;
  if (kind === 'st-teams') {
    const full = computeTeamStandings(rowsNow);
    roundExport = { rows: full, filename: roundExportName(roundNum), cols: [
      ['#', t => t.rank], ['Команда', t => t.team], ['Очки', t => t.total],
      ['Топ-10', t => t.bestPositions.slice(0, 10).join(' · ')],
    ] };
    const prevPos = Object.fromEntries(computeTeamStandings(rowsPrev).map(t => [t.team, t.rank]));
    head = '<th>Команда</th><th class="r">Очки</th><th class="r" title="Десять лучших финишей пилотов команды">Топ-10</th>';
    body = full.filter(t => roundHit(t.team, ...t.drivers))
      .map(t => [t.rank, deltaCell(prevPos[t.team], t.rank),
    `<td><strong>${teamLink(t.team)}</strong>${coalMark(t.team)}</td>
   <td class="r" title="${scorersTooltip(t)}">${penMark(t)}<strong>${t.total}</strong></td>
   <td class="r muted">${t.bestPositions.slice(0, 10).join(' · ') || '—'}</td>`]);
  } else if (kind === 'st-owners') {
    const full = ownersAfter(roundNum);
    roundExport = { rows: full, filename: roundExportName(roundNum), cols: [
      ['#', o => o.rank], ['Номер', o => o.car], ['Пилоты', o => o.drivers.join(' · ')],
      ['Очки', o => o.total], ['Топ-5', o => o.top5.join(' · ')],
    ] };
    const prevPos = Object.fromEntries((prevRound ? ownersAfter(prevRound) : []).map(o => [o.car, o.rank]));
    head = '<th>Номер</th><th>Пилоты</th><th class="r">Очки</th><th class="r" title="Пять лучших финишей">Топ-5</th>';
    body = full.filter(o => roundHit(o.car, ...o.drivers))
      .map(o => [o.rank, deltaCell(prevPos[o.car], o.rank),
    `<td><strong>#${o.car}</strong></td>
   <td class="team-text">${o.drivers.sort().join(' · ')}</td>
   <td class="r"><strong>${o.total}</strong></td>
   <td class="r muted">${o.top5.join(' · ') || '—'}</td>`]);
  } else {
    const full = computeStandings(rowsNow);
    roundExport = { rows: full, filename: roundExportName(roundNum), cols: [
      ['#', s => s.rank], ['Гонщик', s => s.driver], ['Команда', s => s.team],
      ['Авт.', s => s.mfr], ['Очки', s => s.total], ['Победы', s => s.wins],
      ['Топ-5', s => s.bestPositions.slice(0, 5).join(' · ')],
    ] };
    const prevPos = Object.fromEntries(computeStandings(rowsPrev).map(s => [s.driver, s.rank]));
    head = '<th>Гонщик</th><th>Команда</th><th>Авт.</th><th class="r">Очки</th><th class="r">Победы</th>'
      + '<th class="r" title="Пять лучших финишей">Топ-5</th>';
    body = full.filter(s => roundHit(s.driver, s.team))
      .map(s => [s.rank, deltaCell(prevPos[s.driver], s.rank),
    `<td><strong class="driver-link" onclick="openDriver('${s.driver.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')">${s.driver}</strong></td>
   <td class="team-text">${s.team}${coalMark(s.team)}</td>
   <td>${mfrBadge(s.mfr)}</td>
   <td class="r"><strong>${s.total}</strong></td>
   <td class="r">${s.wins > 0 ? `<strong class="win">${s.wins}</strong>` : '<span class="muted">—</span>'}</td>
   <td class="r muted">${s.bestPositions.slice(0, 5).join(' · ') || '—'}</td>`]);
  }

  const html = `<div class="table-scroll"><table class="standings-table" data-sort="auto"><thead><tr>
  <th class="r w-36">#</th>
  <th class="r" title="Изменение позиции к прошлому этапу">±</th>${head}
</tr></thead><tbody>` +
    body.map(([rank, delta, cells]) => `<tr class="${rank <= 3 ? 'rank-' + rank : ''}">
  <td class="r"><span class="pos-badge">${rank}</span></td>
  <td class="r">${delta}</td>${cells}
</tr>`).join('') +
    '</tbody></table></div>';

  document.getElementById('round-table').innerHTML = html;
}

function onRoundChange() {
  const val = document.getElementById('round-select').value;
  const roundNum = parseFloat(val);
  const name = state.roundNames[val] || val;
  const isRound1 = roundNum === 1;

  // Неизвестный вид (например, из старой ссылки) и дуэли вне первого этапа — назад к гонке
  if (!ROUND_VIEWS.includes(roundView)) roundView = 'race';
  if (!isRound1 && (roundView === 'duel1' || roundView === 'duel2')) roundView = 'race';
  renderRoundToggle(isRound1);
  writeHash();

  if (roundView.startsWith('st-')) {
    const titles = { 'st-drivers': 'Личный зачёт', 'st-teams': 'Командный зачёт', 'st-owners': 'Зачёт владельцев' };
    document.getElementById('round-table-title').textContent = `${titles[roundView]} после этапа — ${name}`;
    renderRoundStandings(roundView, roundNum);
    return;
  }
  if (roundView === 'metric-next') {
    document.getElementById('round-table-title').textContent = `Метрика на следующий этап — после этапа ${name}`;
    renderRoundMetric(roundNum);
    return;
  }

  const duelNum = roundView === 'duel1' ? 1.1 : roundView === 'duel2' ? 1.2 : null;

  /* Места по возрастанию; дисквалифицированному (места нет) место в протоколе не положено,
     но показать его надо там, где он был бы по очкам за прогноз: ставим прямо перед лучшим
     из тех, кого он обошёл. Считать «скольких обошёл» нельзя — после DQ в поле остаётся дыра
     (его место никому не отдают), и счёт разъезжается с номерами мест. Никого не обошёл —
     в конец. В квале по метрике очки наоборот: меньше — лучше. */
  const orderField = rows => {
    const metric = rows.every(r => DR_KEYS.every(k => r[k] == null));
    const beats = (a, b) => metric ? (a ?? Infinity) < (b ?? Infinity) : (a ?? -Infinity) > (b ?? -Infinity);
    const key = r => r['Pos.'] ?? Math.min(999, ...rows
      .filter(x => x['Pos.'] != null && beats(r['Points'], x['Points']))
      .map(x => x['Pos.'])) - 0.5;
    return rows.map(r => [key(r), r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  };
  const ofRound = (rows, n) => orderField(rows.filter(r => parseFloat(r['Round']) === n));

  const raceRows = ofRound(state.races.rows, roundNum);
  const duel1Rows = isRound1 ? ofRound(state.quals.rows, 1.1) : [];
  const duel2Rows = isRound1 ? ofRound(state.quals.rows, 1.2) : [];
  const duelRows = duelNum === 1.1 ? duel1Rows : duelNum === 1.2 ? duel2Rows : [];
  const qualRows = ofRound(state.quals.rows, roundNum);

  const hitRow = r => roundHit(r['Driver'], r['Team'], r['#']);
  const raceDrEmpty = raceRows.every(r => DR_KEYS.every(k => r[k] == null));
  const qualDrEmpty = qualRows.every(r => DR_KEYS.every(k => r[k] == null));


  // Цепочка отбора на Дейтоне: квала → любая дуэль → гонка. На обычном этапе
  // дуэльной стадии нет — квала красится по прямому попаданию в гонку, как и раньше.
  const raceDrivers = new Set(raceRows.map(r => r['Driver']));
  const duelDrivers = new Set([...duel1Rows, ...duel2Rows].map(r => r['Driver']));
  const qualPosFmt = (v, r) => {
    if (v == null) return DQ_MARK;
    const made = isRound1 ? duelDrivers.has(r['Driver']) : raceDrivers.has(r['Driver']);
    return `<span class="${made ? 'up' : 'down'}">${v}</span>`;
  };

  const driverQualPos = Object.fromEntries(
    qualRows.map(r => [r['Driver'], r['Pos.']])
  );

  if (roundView === 'race') {
    document.getElementById('round-table-title').textContent = `Гонка — ${name}`;
    const raceCols = [
      { key: 'Pos.', label: 'Поз.', cls: 'r', fmt: v => v == null ? DQ_MARK : v, minKey: 'Pos.' },
      {
        key: 'Driver', label: '±', cls: 'r', fmt: (v, r) => {
          const qp = driverQualPos[r['Driver']];
          const rp = r['Pos.'];
          if (qp == null || rp == null) return '<span class="muted">—</span>';
          // Поле квалы бывает больше поля гонки (эксибишены вроде Клэша) — тогда позиция
          // в квале не может быть дальше последнего реально стартовавшего места
          const effectiveQp = Math.min(qp, raceRows.length);
          const diff = effectiveQp - rp;
          if (diff === 0) return '<span class="muted">0</span>';
          
          return `<span class="${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '+' : ''}${diff}</span>`;
        }
      },
      { key: '#', label: '#', cls: 'r' },
      { key: 'Driver', label: 'Пилот' },
      { key: 'Team', label: 'Команда', fmt: v => `<span class="team-text">${v || '—'}${coalMark(v)}</span>` },
      { key: 'M.', label: 'Авт.', fmt: v => mfrBadge(v) },
      { key: 'QL', label: 'QL', cls: 'r', fmt: v => v ?? '—', maxKey: 'QL' },
      { key: 'DR1', label: 'DR1', cls: 'r', fmt: v => v ?? '—', group: 'dr12', groupTop: 2 },
      { key: 'DR2', label: 'DR2', cls: 'r', fmt: v => v ?? '—', group: 'dr12', groupTop: 2 },
      { key: 'DR3', label: 'DR3', cls: 'r', fmt: v => v ?? '—', maxKey: 'DR3' },
      { key: 'DR4', label: 'DR4', cls: 'r', fmt: v => v ?? '—', maxKey: 'DR4' },
      { key: 'CAU', label: 'CAU', cls: 'r', fmt: v => v ?? '—', maxKey: 'CAU' },
      { key: 'RET', label: 'RET', cls: 'r', fmt: v => v ?? '—', maxKey: 'RET' },
      { key: 'MN', label: 'MN', cls: 'r', fmt: v => v ?? '—', maxKey: 'MN' },
      { key: 'Points', label: 'Очки', cls: 'r', fmt: v => `<strong>${v ?? '—'}</strong>`, ...(raceDrEmpty ? { minKey: 'Points' } : { maxKey: 'Points' }) },
      { key: 'Pos.', label: 'NASCAR', cls: 'r', fmt: (v, r) => `<strong class="nascar-pts">${scorePts(r['Pos.'], roundNum)}</strong>` },
    ];
    roundExport = { rows: raceRows, filename: roundExportName(roundNum), cols: raceCols.filter(c => c.label !== 'NASCAR') };
    renderRoundTable('round-table', raceRows.filter(hitRow), raceCols, raceRows);
  } else if (roundView === 'duel1' || roundView === 'duel2') {
    const duelLabel = roundView === 'duel1' ? 'Дуэль 1' : 'Дуэль 2';
    document.getElementById('round-table-title').textContent = `${duelLabel} — ${name}`;
    const duelPosFmt = (v, r) => {
      if (v == null) return DQ_MARK;
      const made = raceDrivers.has(r['Driver']);
      return `<span class="${made ? 'up' : 'down'}">${v}</span>`;
    };
    const duelDrEmpty = duelRows.every(r => DR_KEYS.every(k => r[k] == null));
    const duelCols = [
      { key: 'Pos.', label: 'Поз.', cls: 'r', fmt: duelPosFmt },
      { key: '#', label: '#', cls: 'r' },
      { key: 'Driver', label: 'Пилот' },
      { key: 'Team', label: 'Команда', fmt: v => `<span class="team-text">${v || '—'}${coalMark(v)}</span>` },
      { key: 'M.', label: 'Авт.', fmt: v => mfrBadge(v) },
      { key: 'DR1', label: 'DR1', cls: 'r', fmt: v => v ?? '—', group: 'dr12', groupTop: 2 },
      { key: 'DR2', label: 'DR2', cls: 'r', fmt: v => v ?? '—', group: 'dr12', groupTop: 2 },
      { key: 'DR3', label: 'DR3', cls: 'r', fmt: v => v ?? '—', maxKey: 'DR3' },
      { key: 'DR4', label: 'DR4', cls: 'r', fmt: v => v ?? '—', maxKey: 'DR4' },
      { key: 'Points', label: 'Очки', cls: 'r', fmt: v => `<strong>${v ?? '—'}</strong>`, ...(duelDrEmpty ? { minKey: 'Points' } : { maxKey: 'Points' }) },
      { key: 'Pos.', label: 'NASCAR', cls: 'r', fmt: (v, r) => `<strong class="nascar-pts">${scorePts(r['Pos.'], duelNum)}</strong>` },
    ];
    roundExport = { rows: duelRows, filename: roundExportName(roundNum), cols: duelCols.filter(c => c.label !== 'NASCAR') };
    renderRoundTable('round-table', duelRows.filter(hitRow), duelCols, duelRows);
  } else {
    document.getElementById('round-table-title').textContent = `Квалификация — ${name}`;
    const qualCols = [
      { key: 'Pos.', label: 'Поз.', cls: 'r', fmt: qualPosFmt },
      { key: '#', label: '#', cls: 'r' },
      { key: 'Driver', label: 'Пилот' },
      { key: 'Team', label: 'Команда', fmt: v => `<span class="team-text">${v || '—'}${coalMark(v)}</span>` },
      { key: 'M.', label: 'Авт.', fmt: v => mfrBadge(v) },
      { key: 'DR1', label: 'DR1', cls: 'r', fmt: v => v ?? '—', group: 'dr12', groupTop: 2 },
      { key: 'DR2', label: 'DR2', cls: 'r', fmt: v => v ?? '—', group: 'dr12', groupTop: 2 },
      { key: 'DR3', label: 'DR3', cls: 'r', fmt: v => v ?? '—', maxKey: 'DR3' },
      { key: 'DR4', label: 'DR4', cls: 'r', fmt: v => v ?? '—', maxKey: 'DR4' },
      { key: 'Points', label: 'Очки', cls: 'r', fmt: v => `<strong>${v ?? '—'}</strong>`, ...(qualDrEmpty ? { minKey: 'Points' } : { maxKey: 'Points' }) },
      { key: 'Pos.', label: 'NASCAR', cls: 'r', fmt: (v, r) => `<strong class="nascar-pts">${scorePts(r['Pos.'], roundNum)}</strong>` },
    ];
    roundExport = { rows: qualRows, filename: roundExportName(roundNum), cols: qualCols.filter(c => c.label !== 'NASCAR') };
    renderRoundTable('round-table', qualRows.filter(hitRow), qualCols, qualRows);
  }
}

function initRoundView() {
  const sel = document.getElementById('round-select');
  // Список этапов для просмотра протокола — по «сырым» строкам, а не state.*.rounds:
  // тот уже без этапа 0 (незачётный), но его протокол смотреть можно и нужно
  const existingRounds = new Set([
    ...uniqueRounds(state.races.rows).map(String),
    ...uniqueRounds(state.quals.rows).map(String),
  ]);
  // календарь приезжает в сводке сезона (state.roundNames), протоколы — по требованию
  const options = Object.keys(state.roundNames)
    .map(Number)
    .filter(n => existingRounds.has(String(n)) && n !== 1.1 && n !== 1.2)
    .sort((a, b) => a - b)
    .map(n => `<option value="${n}">${state.roundNames[String(n)]}</option>`);
  sel.innerHTML = options.join('');
  if (options.length) onRoundChange();
}
