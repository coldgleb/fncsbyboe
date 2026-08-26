/* Вкладка «По этапам»: результаты и зачёты после этапа */

// allRows — полный протокол этапа: подсветку лучших значений поиск сужать не должен
function renderRoundTable(containerId, rows, cols, allRows = rows) {
  const wrap = document.getElementById(containerId);
  if (!rows.length) { wrap.innerHTML = '<div class="round-empty">Нет данных</div>'; return; }

  // Single-column max (maxKey) and min (minKey)
  const colMax = {}, colMin = {};
  for (const col of cols) {
    const vals = col.maxKey || col.minKey
      ? allRows.map(r => r[col.maxKey || col.minKey]).filter(v => v != null && isFinite(v))
      : [];
    if (col.maxKey) colMax[col.maxKey + col.label] = vals.length ? Math.max(...vals) : null;
    if (col.minKey) colMin[col.minKey + col.label] = vals.length ? Math.min(...vals) : null;
  }

  // Group top-N threshold (group + groupTop)
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

  let html = '<div class="table-scroll"><table class="round-table" data-sort="auto"><thead><tr>';
  for (const { label, cls, title } of cols)
    html += `<th class="${cls || ''}"${title ? ` title="${title}"` : ''}>${label}</th>`;
  html += '</tr></thead><tbody>';

  for (const r of rows) {
    html += '<tr>';
    for (const col of cols) {
      const { key, cls, fmt, maxKey, group } = col;
      const v = r[key];
      const display = fmt ? fmt(v, r) : (v == null ? '—' : v);
      const { minKey } = col;
      let highlight = false;
      if (maxKey) {
        const mx = colMax[maxKey + col.label];
        highlight = mx != null && r[maxKey] != null && r[maxKey] === mx;
      } else if (minKey) {
        const mn = colMin[minKey + col.label];
        highlight = mn != null && r[minKey] != null && r[minKey] === mn;
      } else if (group) {
        const thresh = groupThresh[group];
        highlight = thresh != null && v != null && v >= thresh;
      }
      const cellStyle = highlight ? ' style="color:#f1c40f;font-weight:700"' : '';
      html += `<td class="${cls || ''}"${cellStyle}>${display}</td>`;
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

const ROUND_VIEWS = ['race', 'qual', 'clash1', 'clash2', 'st-drivers', 'st-teams', 'st-owners'];
let roundView = 'race';

function setRoundView(view) {
  roundView = view;
  // только свой переключатель: такие же кнопки есть во вкладке GOLUBOCHKIN
  document.querySelectorAll('#round-toggle .rtog-btn').forEach(b => b.classList.toggle('rtog-active', b.dataset.view === view));
  onRoundChange();
}

function renderRoundToggle(isRound1) {
  const btns = isRound1
    ? [['race', 'Гонка'], ['clash1', 'Клэш 1'], ['clash2', 'Клэш 2'], ['qual', 'Квалификация']]
    : [['race', 'Гонка'], ['qual', 'Квалификация']];
  btns.push(['st-drivers', 'Личный'], ['st-teams', 'Командный'], ['st-owners', 'Владельцы']);
  document.getElementById('round-toggle').innerHTML = btns.map(([v, label]) =>
    `<button class="rtog-btn${roundView === v ? ' rtog-active' : ''}" data-view="${v}" onclick="setRoundView('${v}')">${label}</button>`
  ).join('');
}

/* ── Зачёты по состоянию после этапа ── */
function deltaCell(prevRank, rank) {
  if (prevRank == null) return '<span style="color:var(--muted)" title="Новый в зачёте">•</span>';
  const d = prevRank - rank;
  if (d === 0) return '<span style="color:var(--muted)">—</span>';
  return `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`;
}

// Поиск по вкладке: сужает и протокол этапа, и зачёты после него
const roundHit = (...fields) => hit(state.roundFilter, ...fields);

function filterRound(val) {
  state.roundFilter = val;
  onRoundChange();
}

// kind: 'st-drivers' | 'st-teams' | 'st-owners' — зачёт по состоянию после этапа
function renderRoundStandings(kind, roundNum) {
  // Клэши (1.1/1.2) относятся к своему этапу, поэтому граница — до следующего целого
  const upTo = n => state.races.rowsWithClash.filter(r => r['Round'] < n + 1);
  const prevRound = Math.max(...state.races.rounds.filter(r => r < roundNum), 0);
  const rowsNow = upTo(roundNum);
  const rowsPrev = prevRound ? upTo(prevRound) : [];

  let head, body;
  if (kind === 'st-teams') {
    const prevPos = Object.fromEntries(computeTeamStandings(rowsPrev).map(t => [t.team, t.rank]));
    head = '<th>Команда</th><th class="r">Очки</th><th class="r" title="Десять лучших финишей пилотов команды">Топ-10</th>';
    body = computeTeamStandings(rowsNow).filter(t => roundHit(t.team, ...t.drivers))
      .map(t => [t.rank, deltaCell(prevPos[t.team], t.rank),
    `<td><strong>${teamLink(t.team)}</strong>${coalMark(t.team)}</td>
   <td class="r" title="${scorersTooltip(t)}">${penMark(t)}<strong>${t.total}</strong></td>
   <td class="r" style="color:var(--muted)">${t.bestPositions.slice(0, 10).join(' · ') || '—'}</td>`]);
  } else if (kind === 'st-owners') {
    const prevPos = Object.fromEntries(computeOwnerStandings(rowsPrev).map(o => [o.car, o.rank]));
    head = '<th>Номер</th><th>Пилоты</th><th class="r">Очки</th><th class="r" title="Пять лучших финишей">Топ-5</th>';
    body = computeOwnerStandings(rowsNow).filter(o => roundHit(o.car, ...o.drivers))
      .map(o => [o.rank, deltaCell(prevPos[o.car], o.rank),
    `<td><strong>#${o.car}</strong></td>
   <td class="team-text">${o.drivers.sort().join(' · ')}</td>
   <td class="r"><strong>${o.total}</strong></td>
   <td class="r" style="color:var(--muted)">${o.top5.join(' · ') || '—'}</td>`]);
  } else {
    const prevPos = Object.fromEntries(computeStandings(rowsPrev).map(s => [s.driver, s.rank]));
    head = '<th>Гонщик</th><th>Команда</th><th>Авт.</th><th class="r">Очки</th><th class="r">Победы</th>'
      + '<th class="r" title="Пять лучших финишей">Топ-5</th>';
    body = computeStandings(rowsNow).filter(s => roundHit(s.driver, s.team))
      .map(s => [s.rank, deltaCell(prevPos[s.driver], s.rank),
    `<td><strong class="driver-link" onclick="openDriver('${s.driver.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')">${s.driver}</strong></td>
   <td class="team-text">${s.team}${coalMark(s.team)}</td>
   <td>${mfrBadge(s.mfr)}</td>
   <td class="r"><strong>${s.total}</strong></td>
   <td class="r">${s.wins > 0 ? `<strong style="color:#d4af37">${s.wins}</strong>` : '<span style="color:var(--muted)">—</span>'}</td>
   <td class="r" style="color:var(--muted)">${s.bestPositions.slice(0, 5).join(' · ') || '—'}</td>`]);
  }

  const html = `<div class="table-scroll"><table class="standings-table" data-sort="auto"><thead><tr>
  <th class="r" style="width:36px">#</th>
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

  // Неизвестный вид (например, из старой ссылки) и клэши вне первого этапа — назад к гонке
  if (!ROUND_VIEWS.includes(roundView)) roundView = 'race';
  if (!isRound1 && (roundView === 'clash1' || roundView === 'clash2')) roundView = 'race';
  renderRoundToggle(isRound1);
  writeHash();

  if (roundView.startsWith('st-')) {
    const titles = { 'st-drivers': 'Личный зачёт', 'st-teams': 'Командный зачёт', 'st-owners': 'Зачёт владельцев' };
    document.getElementById('round-table-title').textContent = `${titles[roundView]} после этапа — ${name}`;
    renderRoundStandings(roundView, roundNum);
    return;
  }

  const clashNum = roundView === 'clash1' ? 1.1 : roundView === 'clash2' ? 1.2 : null;

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
  const clashRows = clashNum != null ? ofRound(state.quals.rows, clashNum) : [];
  const qualRows = ofRound(state.quals.rows, roundNum);

  const hitRow = r => roundHit(r['Driver'], r['Team'], r['#']);
  const raceDrEmpty = raceRows.every(r => DR_KEYS.every(k => r[k] == null));
  const qualDrEmpty = qualRows.every(r => DR_KEYS.every(k => r[k] == null));


  const maxRacePos = raceRows.reduce((mx, r) => r['Pos.'] != null ? Math.max(mx, r['Pos.']) : mx, 0) || 40;
  const qualPosFmt = v => {
    if (v == null) return DQ_MARK;
    const green = v >= 1 && v <= maxRacePos;
    return `<span style="color:${green ? '#2ecc71' : '#e63946'};font-weight:700">${v}</span>`;
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
          if (qp == null || rp == null) return '<span style="color:var(--muted)">—</span>';
          const diff = qp - rp;
          if (diff === 0) return '<span style="color:var(--muted)">0</span>';
          const color = diff > 0 ? '#2ecc71' : '#e63946';
          return `<span style="color:${color};font-weight:700">${diff > 0 ? '+' : ''}${diff}</span>`;
        }
      },
      { key: '#', label: '#', cls: 'r' },
      { key: 'Driver', label: 'Пилот' },
      { key: 'Team', label: 'Команда', fmt: v => `<span style="color:var(--muted);font-size:0.78rem">${v || '—'}${coalMark(v)}</span>` },
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
      { key: 'Pos.', label: 'NASCAR', cls: 'r', fmt: (v, r) => `<strong style="color:var(--accent)">${scorePts(r['Pos.'], roundNum)}</strong>` },
    ];
    renderRoundTable('round-table', raceRows.filter(hitRow), raceCols, raceRows);
  } else if (roundView === 'clash1' || roundView === 'clash2') {
    const clashLabel = roundView === 'clash1' ? 'Клэш 1' : 'Клэш 2';
    document.getElementById('round-table-title').textContent = `${clashLabel} — ${name}`;
    const clashHalf = Math.ceil(raceRows.length / 2);
    const clashPosFmt = v => {
      if (v == null) return DQ_MARK;
      const green = v >= 1 && v <= clashHalf;
      return `<span style="color:${green ? '#2ecc71' : '#e63946'};font-weight:700">${v}</span>`;
    };
    const clashDrEmpty = clashRows.every(r => DR_KEYS.every(k => r[k] == null));
    const clashCols = [
      { key: 'Pos.', label: 'Поз.', cls: 'r', fmt: clashPosFmt },
      { key: '#', label: '#', cls: 'r' },
      { key: 'Driver', label: 'Пилот' },
      { key: 'Team', label: 'Команда', fmt: v => `<span style="color:var(--muted);font-size:0.78rem">${v || '—'}${coalMark(v)}</span>` },
      { key: 'M.', label: 'Авт.', fmt: v => mfrBadge(v) },
      { key: 'DR1', label: 'DR1', cls: 'r', fmt: v => v ?? '—', group: 'dr12', groupTop: 2 },
      { key: 'DR2', label: 'DR2', cls: 'r', fmt: v => v ?? '—', group: 'dr12', groupTop: 2 },
      { key: 'DR3', label: 'DR3', cls: 'r', fmt: v => v ?? '—', maxKey: 'DR3' },
      { key: 'DR4', label: 'DR4', cls: 'r', fmt: v => v ?? '—', maxKey: 'DR4' },
      { key: 'Points', label: 'Очки', cls: 'r', fmt: v => `<strong>${v ?? '—'}</strong>`, ...(clashDrEmpty ? { minKey: 'Points' } : { maxKey: 'Points' }) },
      { key: 'Pos.', label: 'NASCAR', cls: 'r', fmt: (v, r) => `<strong style="color:var(--accent)">${scorePts(r['Pos.'], clashNum)}</strong>` },
    ];
    renderRoundTable('round-table', clashRows.filter(hitRow), clashCols, clashRows);
  } else {
    document.getElementById('round-table-title').textContent = `Квалификация — ${name}`;
    const qualCols = [
      { key: 'Pos.', label: 'Поз.', cls: 'r', fmt: qualPosFmt },
      { key: '#', label: '#', cls: 'r' },
      { key: 'Driver', label: 'Пилот' },
      { key: 'Team', label: 'Команда', fmt: v => `<span style="color:var(--muted);font-size:0.78rem">${v || '—'}${coalMark(v)}</span>` },
      { key: 'M.', label: 'Авт.', fmt: v => mfrBadge(v) },
      { key: 'DR1', label: 'DR1', cls: 'r', fmt: v => v ?? '—', group: 'dr12', groupTop: 2 },
      { key: 'DR2', label: 'DR2', cls: 'r', fmt: v => v ?? '—', group: 'dr12', groupTop: 2 },
      { key: 'DR3', label: 'DR3', cls: 'r', fmt: v => v ?? '—', maxKey: 'DR3' },
      { key: 'DR4', label: 'DR4', cls: 'r', fmt: v => v ?? '—', maxKey: 'DR4' },
      { key: 'Points', label: 'Очки', cls: 'r', fmt: v => `<strong>${v ?? '—'}</strong>`, ...(qualDrEmpty ? { minKey: 'Points' } : { maxKey: 'Points' }) },
      { key: 'Pos.', label: 'NASCAR', cls: 'r', fmt: (v, r) => `<strong style="color:var(--accent)">${scorePts(r['Pos.'], roundNum)}</strong>` },
    ];
    renderRoundTable('round-table', qualRows.filter(hitRow), qualCols, qualRows);
  }
}

function initRoundView(roundRows) {
  state.roundNames = {};
  for (const r of roundRows) {
    const num = r['#'];
    if (num == null) continue;
    const key = String(num);
    state.roundNames[key] = `${fmtRoundNum(num)} · ${r['Name'] || ''}`;
  }

  const sel = document.getElementById('round-select');
  // Only show rounds that exist in Races or Quals data
  const existingRounds = new Set([
    ...state.races.rounds.map(String),
    ...state.quals.rounds.map(String),
  ]);
  const options = roundRows
    .filter(r => r['#'] != null && existingRounds.has(String(r['#'])) && r['#'] !== 1.1 && r['#'] !== 1.2)
    .map(r => {
      const key = String(r['#']);
      return `<option value="${r['#']}">${state.roundNames[key]}</option>`;
    });
  sel.innerHTML = options.join('');
  if (options.length) onRoundChange();
}
