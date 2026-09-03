/* Личные зачёты: итоговая таблица, сортировка, сводная Пилот · Этап · Позиция */

function driverTooltip(s) {
  return [
    `Тай-брейк: ${s.wins} побед` + (s.firstWin !== Infinity ? ` · 1-я победа R${fmtRoundNum(s.firstWin)}` : '') + ` · ${s.sheetPts} очков за прогноз`,
    `Сред. позиция: ${avgPos(s)}`,
    `Топ-5: ${s.top5} · Топ-10: ${s.top10}`,
  ].join('\n');
}

/* ── Срез зачёта после выбранного этапа ── */

// Этапы, доступные для среза; дуэли — часть первого этапа, отдельной строкой не нужны
const roundsOf = type => (/quals/i.test(type) ? state.quals : state.races).rounds
  .filter(r => !SPRINT_ROUNDS.has(r));

const isIndep = team => team && team !== '—' && !state.coalitions?.has(team);

// Реальный Чейз (очки сброшены на сетку), а не просто «топ-16 в зачёте»:
// с 27 этапа — всегда, на 26-м — по переключателю. У независимых Чейза нет вообще.
const isChaseMode = (type, n) => !type.startsWith('ind')
  && (n > CHASE_START || (n === CHASE_START && state.chaseView[type] === 'chase'));

// Зачёт по состоянию после этапа n (дуэли относятся к своему этапу — граница до следующего целого)
function standingsUpTo(type, n) {
  const rows = (/quals/i.test(type) ? state.quals.rows : state.races.rowsWithDuel)
    .filter(r => r['Round'] < n + 1);
  const st = isChaseMode(type, n) ? computeChaseStandings(rows) : computeStandings(rows);
  return type.startsWith('ind')
    ? renumber(st.filter(s => isIndep(s.team)))
    : st;
}

function setChaseView(type, val) {
  state.chaseView[type] = val;
  renderTable(type);
}

function setUpTo(type, val) {
  const rounds = roundsOf(type);
  const n = parseFloat(val);
  state.upTo[type] = n === rounds[rounds.length - 1] ? null : n;
  state.page[type] = 1;
  renderTable(type);
}

function renderTable(type) {
  const wrap = document.getElementById(`table-${type}`);
  const rounds = roundsOf(type);
  const lastRound = rounds[rounds.length - 1];
  const at = state.upTo[type] ?? lastRound;
  const isLast = at === lastRound;
  const all = standingsUpTo(type, at);
  // ± к прошлому этапу
  const prevRound = Math.max(...rounds.filter(r => r < at), 0);
  const prevRank = prevRound
    ? Object.fromEntries(standingsUpTo(type, prevRound).map(s => [s.driver, s.rank]))
    : {};
  // участие считаем до выбранного этапа, иначе срез врёт про пропуски
  const starts = (kind, d) => [...(state.attendance[kind][d] || [])].filter(r => r <= at).length;
  const q = state.filter[type].toLowerCase();
  const filtered = q
    ? all.filter(s => s.driver.toLowerCase().includes(q) || s.team.toLowerCase().includes(q))
    : all;

  // Чейз считается только в общих зачётах, не в зачёте независимых; виден на любом
  // срезе сезона, начиная с 1 этапа (playoffSet — по текущему/итоговому зачёту,
  // а сам разрыв — по очкам на выбранный этап, как и обещает upto-note ниже)
  const withChase = !type.startsWith('ind');
  const playoffSet = withChase ? buildPlayoffSet(all, at) : new Set();
  const isChase = withChase && isChaseMode(type, at);

  const chase = all.filter(s => playoffSet.has(s.driver));   // чейзовые в порядке появления в all
  // Линия — всегда сразу после ПОСЛЕДНЕГО чейзового по факту появления, а не по позиции:
  // ценз квалификаций может выбить кого-то из топ-16 по очкам, тогда чейзовые идут не подряд.
  // Сам «после чейза» не может быть гостем — гость вне зачёта и границу не определяет
  let lastChaseIdx = -1;
  all.forEach((s, i) => { if (playoffSet.has(s.driver)) lastChaseIdx = i; });
  let afterChase = null;
  for (let j = lastChaseIdx + 1; j < all.length; j++) {
    if (!all[j].isGuest) { afterChase = all[j]; break; }
  }

  // Регулярный сезон (очки не сброшены) — старый расчёт «до отсечки»
  const cutoffDriver = all.find(s => !s.isGuest && !playoffSet.has(s.driver) && qualEligible(s.driver, at));
  const lastChase = chase[chase.length - 1];
  // Чейз (очки уже сброшены на сетку) — расчёт «внутри своей группы»
  const chaseLeader = chase[0];

  const gapCell = s => {
    const dash = '<span style="color:var(--muted)">—</span>';
    if (s.isGuest || !qualEligible(s.driver, at)) return dash;
    const ref = isChase
      ? (playoffSet.has(s.driver) ? chaseLeader : afterChase)
      : (playoffSet.has(s.driver) ? cutoffDriver : lastChase);
    if (!ref) return dash;
    if (s.driver === ref.driver) return '<span style="color:var(--muted)">0</span>';
    const d = s.total - ref.total;
    if (d === 0) return '<span style="color:var(--muted)" title="Равенство очков — решает тай-брейк">0</span>';
    return `<span style="color:${d > 0 ? '#2ecc71' : '#e63946'};font-weight:700">${d > 0 ? '+' : ''}${d}</span>`;
  };

  const sort = state.sort[type];
  const rows = sort
    ? [...filtered].sort((a, b) => {
      const va = SORT_KEYS[sort.key](a), vb = SORT_KEYS[sort.key](b);
      const d = typeof va === 'string' || typeof vb === 'string'
        ? String(va).localeCompare(String(vb), 'ru')
        : va - vb;
      return sort.dir === 'asc' ? d : -d;
    })
    : filtered;

  const sortTh = (key, label, attrs = '', cls = 'r') => {
    const arrow = sort && sort.key === key ? ` <span class="sort-arrow">${sort.dir === 'asc' ? '▲' : '▼'}</span>` : '';
    return `<th class="${cls} sortable" ${attrs} onclick="sortTable('${type}','${key}')">${label}${arrow}</th>`;
  };

  const page = state.page[type];
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // При своей сортировке места нумеруются 1..n заново (сквозной номер по всему rows,
  // не только по странице) — гостей при этом пропускаем, у них номера нет вообще
  let sortSeq = 0;
  const sortPlaceOf = sort ? rows.map(s => (s.isGuest ? null : ++sortSeq)) : null;

  const uptoHtml = `<div class="table-upto">
  <label>Зачёт после этапа:
    <select class="chart-select" onchange="setUpTo('${type}', this.value)">
      ${rounds.map(r => `<option value="${r}"${r === at ? ' selected' : ''}>${roundFullName(r)}</option>`).join('')}
    </select>
  </label>
  ${isLast ? '' : '<span class="upto-note">срез сезона: Чейз и тай-брейки — на этот этап</span>'}
  ${!type.startsWith('ind') && at === CHASE_START ? `
  <div class="round-toggle" style="margin-left:10px">
    <button class="rtog-btn${state.chaseView[type] !== 'chase' ? ' rtog-active' : ''}" onclick="setChaseView('${type}','regular')">Регулярный сезон</button>
    <button class="rtog-btn${state.chaseView[type] === 'chase' ? ' rtog-active' : ''}" onclick="setChaseView('${type}','chase')">Чейз</button>
  </div>` : ''}
</div>`;
  // Если в шапке карточки есть свой контейнер под этот блок — рендерим туда,
  // а не внутрь тела таблицы (пока используется только для «Квалификации»)
  const uptoContainer = document.getElementById(`upto-${type}`);

  let html = uptoContainer ? '' : uptoHtml;
  html += `<div class="table-scroll"><table class="standings-table"><thead><tr>
${sortTh('rank', '#', 'style="width:40px"')}
<th class="r" style="width:44px" title="Изменение места к прошлому этапу">±</th>
${sortTh('driver', 'Гонщик', '', '')}
${sortTh('team', 'Команда', '', '')}
${sortTh('mfr', 'Авт.', '', '')}
${sortTh('total', 'Очки')}
${withChase ? sortTh('chase', '± Чейз', 'title="В Чейзе — преимущество над первым вне Чейза; вне Чейза — отставание от последнего из Чейза"') : ''}
${sortTh('wins', 'Победы', 'title="Количество побед (тай-брейк 1)"')}
${sortTh('starts', 'Гонок / Квал.', 'title="Проходов в гонку / участий в квалификации"')}
${sortTh('best', 'Лучш.')}
  </tr></thead><tbody>`;

  slice.forEach((s, i) => {
    // при своей сортировке места фиксированы: 1..n сверху вниз, место в зачёте — в тултипе;
    // у гостя (в т.ч. временного — сменил дивизион по листу Changes) места нет вообще
    const place = sort ? sortPlaceOf[(page - 1) * PAGE_SIZE + i] : s.rank;
    const inPlayoff = playoffSet.has(s.driver);
    const isCutoff = afterChase && s.driver === afterChase.driver;
    const rc = [
      place != null && place <= 3 ? `rank-${place}` : '',
      inPlayoff ? 'row-playoff' : '',
      isCutoff ? 'row-cutoff' : '',
    ].filter(Boolean).join(' ');

    const winsCell = s.wins > 0
      ? `<strong style="color:#d4af37">${s.wins}</strong>`
      : `<span style="color:var(--muted)">—</span>`;
    const tb = driverTooltip(s);
    html += `<tr class="${rc}" title="${tb}">
  <td class="r"><span class="pos-badge"${sort && place != null ? ` title="Место в зачёте: ${s.rank}"` : ''}>${place ?? '—'}</span></td>
  <td class="r">${s.isGuest ? '<span style="color:var(--muted)">—</span>' : deltaCell(prevRank[s.driver], s.rank)}</td>
  <td><strong class="driver-link" onclick="openDriver('${s.driver.replace(/'/g, "\\'").replace(/"/g, '&quot;')}'${/quals/i.test(type) ? ",'quals'" : ''})">${s.driver}</strong></td>
  <td class="team-text">${s.team}${coalMark(s.team)}</td>
  <td>${mfrBadge(s.mfr)}</td>
  <td class="r"><strong>${s.total}</strong></td>
  ${withChase ? `<td class="r">${gapCell(s)}</td>` : ''}
  <td class="r">${winsCell}</td>
  <td class="r" style="color:var(--muted)">${starts('races', s.driver)} / ${starts('quals', s.driver)}</td>
  <td class="r" style="color:var(--muted)">${s.best === Infinity ? '—' : 'P' + s.best}</td>
</tr>`;
  });

  html += '</tbody></table></div>'
    + paginationHtml(page, pages, `${rows.length} участников`, p => `goPage('${type}',${p})`);

  wrap.innerHTML = html;
  if (uptoContainer) uptoContainer.innerHTML = uptoHtml;
}

const SORT_KEYS = {
  rank: s => s.rank,
  driver: s => s.driver,
  team: s => s.team,
  mfr: s => s.mfr,
  total: s => s.total,
  chase: s => s.total,   // отрыв от границы Чейза — та же очерёдность, что и по очкам
  wins: s => s.wins,
  starts: s => state.attendance.races[s.driver]?.size || 0,
  best: s => s.best,
};

// Клик: по возрастанию, повторный — по убыванию, третий — назад к местам в чемпионате
function sortTable(type, key) {
  const cur = state.sort[type];
  state.sort[type] = !cur || cur.key !== key ? { key, dir: 'asc' }
    : cur.dir === 'asc' ? { key, dir: 'desc' }
      : null;
  state.page[type] = 1;
  renderTable(type);
}

function filterTable(type, val) {
  state.filter[type] = val;
  state.page[type] = 1;
  renderTable(type);
}

// Выгружает весь зачёт целиком (тот же срез по этапу, что и на экране), а не только
// текущую страницу и не только строки, прошедшие поиск.
function exportStandingsCSV(type) {
  const rounds = roundsOf(type);
  const lastRound = rounds[rounds.length - 1];
  const at = state.upTo[type] ?? lastRound;
  const isLast = at === lastRound;
  const all = standingsUpTo(type, at);
  const starts = (kind, d) => [...(state.attendance[kind][d] || [])].filter(r => r <= at).length;

  // Тот же разрыв/запас Чейза, что и gapCell на экране (см. renderTable выше) —
  // виден на любом срезе, начиная с 1 этапа, не только на самом свежем
  const withChase = !type.startsWith('ind');
  const playoffSet = withChase ? buildPlayoffSet(all, at) : new Set();
  const isChase = withChase && isChaseMode(type, at);
  const chase = all.filter(s => playoffSet.has(s.driver));
  let lastChaseIdx = -1;
  all.forEach((s, i) => { if (playoffSet.has(s.driver)) lastChaseIdx = i; });
  let afterChase = null;
  for (let j = lastChaseIdx + 1; j < all.length; j++) {
    if (!all[j].isGuest) { afterChase = all[j]; break; }
  }
  const cutoffDriver = all.find(s => !s.isGuest && !playoffSet.has(s.driver) && qualEligible(s.driver, at));
  const lastChase = chase[chase.length - 1];
  const chaseLeader = chase[0];
  const chaseGap = s => {
    if (s.isGuest || !qualEligible(s.driver, at)) return '';
    const ref = isChase
      ? (playoffSet.has(s.driver) ? chaseLeader : afterChase)
      : (playoffSet.has(s.driver) ? cutoffDriver : lastChase);
    if (!ref) return '';
    const d = s.total - ref.total;
    return d > 0 ? `+${d}` : String(d);
  };

  downloadCSV(csvFromRows(all, [
    ['#', s => s.rank],
    ['Гонщик', s => s.driver],
    ['Команда', s => s.team],
    ['Авт.', s => s.mfr],
    ['Очки', s => s.total],
    ...(withChase ? [['± Чейз', chaseGap]] : []),
    ['Победы', s => s.wins],
    ['Гонок', s => starts('races', s.driver)],
    ['Квал.', s => starts('quals', s.driver)],
    ['Лучш.', s => s.best === Infinity ? '' : s.best],
  ]), `${type}.csv`);
}

function goPage(type, p) {
  state.page[type] = p;
  renderTable(type);
}

function buildPivotData(type) {
  const rows = state[type].rows;
  const rounds = state[type].rounds;
  const standings = state[type].standings;

  /* Ключ этапа заводится и без места: null здесь — это DQ (строка есть, места нет),
     отсутствие ключа — «не участвовал». Реальное место всегда перебивает null. */
  const posMap = src => {
    const m = {};
    for (const r of src) {
      const d = r['Driver'], rnd = r['Round'], pos = r['Pos.'];
      if (!d || rnd == null) continue;
      m[d] ||= {};
      const cur = m[d][rnd];
      if (pos != null && (cur == null || pos < cur)) m[d][rnd] = pos;
      else if (cur === undefined) m[d][rnd] = null;
    }
    return m;
  };

  const map = posMap(rows);
  // For races pivot: build qual map (round → driver → qual pos)
  const qualMap = type === 'races' ? posMap(state.quals.rows) : null;

  const order = standings.map(s => s.driver);
  // Место — из самого зачёта (у гостя оно null), а не из позиции в массиве
  const rankOf = Object.fromEntries(standings.map(s => [s.driver, s.rank]));
  return { map, rounds, order, qualMap, rankOf };
}

function renderPivot(type) {
  const wrap = document.getElementById(`pivot-${type}`);
  const { map, rounds, order, qualMap, rankOf } = buildPivotData(type);
  const q = state.pivot[type];
  const drivers = order.filter(d => hit(q, d, teamOf(d)));

  let html = `<table class="pivot-table" data-sort="auto"><thead><tr>
<th class="driver-col">Место · Пилот</th>
${rounds.map(r => `<th title="${roundFullName(r)}">${roundLabel(r)}</th>`).join('')}
<th>Итого</th>
  </tr></thead><tbody>`;

  for (const driver of drivers) {
    const rank = rankOf[driver];
    const dmap = map[driver] || {};
    const qmap = qualMap ? (qualMap[driver] || {}) : null;
    const total = rounds.reduce((s, r) => s + scorePts(dmap[r], r), 0);
    html += `<tr class="${rank != null && rank <= 3 ? 'rank-' + rank : ''}">
  <td class="driver-cell"><span class="pos-badge">${rank ?? '—'}</span> ${driver}${coalMark(teamOf(driver))}
  <div class="team-drivers">${teamOf(driver)}</div></td>`;
    for (const r of rounds) {
      const pos = dmap[r];
      const qpos = qmap ? qmap[r] : null;
      const maxPos = state.roundMaxPos[r] || 40;
      // ключ есть, а места нет — дисквалификация; ключа нет — этап пропущен
      const raceCell = pos != null
        ? `<span class="pos-cell ${posClass(pos, maxPos)}">${pos}</span>`
        : r in dmap ? DQ_MARK : `<span class="pos-cell pos-none">—</span>`;
      const qualCell = qmap == null ? '' : qpos != null
        ? `<span class="pivot-qpos" style="color:${qpos <= maxPos ? '#2ecc71' : '#e63946'}">${qpos}</span>`
        : r in qmap ? DQ_MARK : `<span class="pivot-qpos pos-none">—</span>`;
      html += `<td>${raceCell}${qualCell}</td>`;
    }
    html += `<td class="total-cell">${total}</td></tr>`;
  }

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

// Полный протокол сезона — как в официальной таблице: Pos/#/Пилот/Команда/Авт. + место на
// каждом этапе + итоговые очки. Порядок и очки берём из финального зачёта (state[type].standings),
// а не из текущего среза «до этапа», — тут всегда весь сезон целиком.
function exportProtocolCSV(type) {
  const { map, rounds } = buildPivotData(type);
  const standings = state[type].standings;
  const cols = [
    ['Pos.', s => s.rank],
    ['#', s => s.car],
    ['Driver', s => s.driver],
    ['Team', s => s.team],
    ['M.', s => s.mfr],
    ...rounds.map(r => [roundLabel(r), s => {
      const dmap = map[s.driver] || {};
      const pos = dmap[r];
      return pos != null ? pos : r in dmap ? 'DQ' : '';
    }]),
    ['Points', s => s.total],
  ];
  downloadCSV(csvFromRows(standings, cols), `${exportSeriesLabel()}.csv`);
}

// Тот же протокол, что и exportProtocolCSV, но в .xlsx с заливкой ячеек по месту —
// как в официальной таблице (жёлтый P1, серый топ-5, бронза топ-10, зелёный/фиолет ниже, красный — вне зачёта).
const TOP3_FILL = ['FFE8A3', 'E0E0E0', 'EFD3B4'];

async function exportProtocolXLSX(type) {
  const { map, rounds } = buildPivotData(type);
  // Место и очки — по срезу, выбранному в интерфейсе («Зачёт после этапа» + Чейз),
  // а не всегда по итогу сезона; сетка позиций по этапам (map/rounds) при этом полная
  const roundsAvail = roundsOf(type);
  const at = state.upTo[type] ?? roundsAvail[roundsAvail.length - 1];
  const standings = standingsUpTo(type, at);
  const maxPosOf = r => state.roundMaxPos[r] || 40;
  const cellFor = (s, r) => {
    const pos = (map[s.driver] || {})[r];
    return pos != null ? pos : r in (map[s.driver] || {}) ? 'DQ' : '';
  };

  // Третий элемент — номер этапа (только у колонок этапов); нужен и для чистки
  // пустых столбцов, и потом для заливки по месту в конкретном этапе
  let cols = [
    ['Pos.', s => s.rank],
    ['#', s => s.car],
    ['Driver', s => s.driver],
    ['Team', s => s.team],
    ['M.', s => s.mfr],
    ...rounds.map(r => [roundLabel(r), s => cellFor(s, r), r]),
    ['Points', s => s.total],
  ];
  cols = dropEmptyCols(cols, standings);
  const rows = dropEmptyRows(cols, standings);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(type === 'quals' ? 'Quals' : 'Races', { views: [{ state: 'frozen', xSplit: 5, ySplit: 1 }] });

  ws.addRow(cols.map(([label]) => label));
  ws.getRow(1).eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = solidFill('1A1A1A');
    c.alignment = { horizontal: 'center' };
  });

  // До какого столбца красим топ-3 сплошной заливкой — все «опознавательные» колонки
  // (Pos/#/Driver/Team/M.), сколько бы из них ни выжило после чистки пустых
  let idCols = cols.findIndex(([, , round]) => round != null);
  if (idCols === -1) idCols = cols.length - 1; // остался только Points
  if (idCols < 1) idCols = cols.length;

  for (const s of rows) {
    const dmap = map[s.driver] || {};
    const row = ws.addRow(cols.map(([, fn]) => fn(s)));
    if (s.rank != null && s.rank <= 3) for (let i = 1; i <= idCols; i++) row.getCell(i).fill = solidFill(TOP3_FILL[s.rank - 1]);
    cols.forEach(([, , round], i) => {
      if (round == null) return;
      const cell = row.getCell(i + 1);
      cell.alignment = { horizontal: 'center' };
      const pos = dmap[round];
      if (pos != null) cell.fill = solidFill(posFillHex(pos, maxPosOf(round)));
      else if (round in dmap) cell.fill = solidFill('E68A90');
    });
  }

  autoSizeColumns(ws);
  downloadXLSX(wb, `${exportSeriesLabel()}.xlsx`);
}

function filterPivot(type, val) {
  state.pivot[type] = val;
  renderPivot(type);
}

/* ── Отыгранные / потерянные позиции: старт (квала) − финиш (гонка) за весь сезон.
   Дуэли не в счёт: своей квалификации у них нет. Этапы без одной из двух позиций пропускаются. ── */
function computeGains() {
  const posByRound = rows => {
    const m = {};
    for (const r of rows) {
      const d = r['Driver'], rnd = r['Round'], pos = r['Pos.'];
      if (!d || isGuestDriver(d) || rnd == null || pos == null || SPRINT_ROUNDS.has(rnd) || rnd === 0) continue;
      // как в карточке пилота: если строк на этап несколько, берём лучшую
      if (m[d]?.[rnd] == null || pos < m[d][rnd]) (m[d] ||= {})[rnd] = pos;
    }
    return m;
  };
  const race = posByRound(state.races.rows);
  const qual = posByRound(state.quals.rows);

  return Object.keys(race).map(d => {
    const cells = {};
    let gained = 0, lost = 0;
    for (const [rnd, rp] of Object.entries(race[d])) {
      const qp = qual[d]?.[rnd];
      if (qp == null) continue;
      const diff = qp - rp;
      cells[rnd] = { diff, qp, rp };
      if (diff > 0) gained += diff; else lost -= diff;
    }
    const n = Object.keys(cells).length;
    return { driver: d, team: teamOf(d), cells, gained, lost, net: gained - lost, n };
  })
    .filter(g => g.n)
    .sort((a, b) => b.net - a.net || b.gained - a.gained)
    .map((g, i) => ({ ...g, rank: i + 1 }));
}

const gainClass = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
const signed = v => (v > 0 ? '+' : '') + v;

function renderGainPivot() {
  const rounds = state.races.rounds.filter(r => !SPRINT_ROUNDS.has(r));
  const list = state.gains.filter(g => hit(state.gainFilter, g.driver, g.team));

  let html = `<table class="pivot-table" data-sort="auto"><thead><tr>
<th class="driver-col">Место · Пилот</th>
${rounds.map(r => `<th title="${roundFullName(r)}">${roundLabel(r)}</th>`).join('')}
<th title="Сумма отыгранных позиций">Отыграно</th>
<th title="Сумма потерянных позиций">Потеряно</th>
<th title="Отыграно минус потеряно">Итого</th>
<th title="В среднем за этап">Сред.</th>
  </tr></thead><tbody>`;

  for (const g of list) {
    html += `<tr class="${g.rank <= 3 ? 'rank-' + g.rank : ''}">
  <td class="driver-cell"><span class="pos-badge">${g.rank}</span> ${g.driver}${coalMark(g.team)}
  <div class="team-drivers">${g.team}</div></td>`;
    for (const r of rounds) {
      const c = g.cells[r];
      html += c == null
        ? '<td><span style="color:var(--border)">—</span></td>'
        : `<td title="${roundFullName(r)}: старт P${c.qp} → финиш P${c.rp}"><span class="${gainClass(c.diff)}">${signed(c.diff)}</span></td>`;
    }
    html += `<td class="up">+${g.gained}</td>
  <td class="down">${g.lost ? '-' + g.lost : 0}</td>
  <td class="total-cell"><span class="${gainClass(g.net)}">${signed(g.net)}</span></td>
  <td><span class="${gainClass(g.net)}">${signed(+(g.net / g.n).toFixed(1))}</span></td></tr>`;
  }
  document.getElementById('pivot-gains').innerHTML = html + '</tbody></table>';
}

function filterGains(val) {
  state.gainFilter = val;
  renderGainPivot();
}
