/* Личные зачёты: итоговая таблица, сортировка, сводная Пилот · Этап · Позиция */

function driverTooltip(s) {
  // У чейзовых пилотов тай-брейк — по результатам Чейза (s.chase), статистика — за сезон
  const tb = s.chase || s;
  const winsLabel = s.chase ? `${tb.wins} побед в Чейзе (${s.wins} за сезон)` : `${s.wins} побед`;
  return [
    `Тай-брейк: ${winsLabel}` + (tb.firstWin != null ? ` · 1-я победа R${fmtRoundNum(tb.firstWin)}` : '') + ` · ${s.sheetPts} очков за прогноз`,
    `Сред. позиция: ${avgPos(s)}`,
    `Топ-5: ${s.top5} · Топ-10: ${s.top10}`,
  ].join('\n');
}

/* ── Срез зачёта после выбранного этапа ── */

// Этапы, доступные для среза; дуэли — часть первого этапа, отдельной строкой не нужны
const roundsOf = type => (/quals/i.test(type) ? state.quals : state.races).rounds
  .filter(r => !SPRINT_ROUNDS.has(r));

/* Реальный Чейз (очки сброшены на сетку) — только после 26 этапа: до этого ручной
   выбор «Чейз» не действует, сколько бы раз его ни включали на позднем срезе.
   Отсечка топ-16 при этом остаётся на любом этапе. */
const isChaseMode = (type, n) => n > CHASE_START && state.chaseView[type] !== 'regular';

/* Срез зачёта на выбранный этап считает база (api.slice): места, «± Чейз», граница
   Чейза. Ответ кладём в state.slices — повторный показ той же таблицы мгновенный. */
function sliceKey(type, at) {
  return `${type}:${at}:${state.chaseView[type] || 'auto'}`;
}

async function fetchSlice(type, at, fresh) {
  const key = sliceKey(type, at);
  if (!fresh && state.slices[key]) return state.slices[key];
  const data = await rpc('slice', {
    season: state.year, division: state.division, session: type, upto: at,
    chase: state.chaseView[type] || 'auto',
  }, fresh ?? state.fresh);
  state.slices[key] = data;
  return data;
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

async function renderTable(type) {
  const wrap = document.getElementById(`table-${type}`);
  const rounds = roundsOf(type);
  const lastRound = rounds[rounds.length - 1];
  const at = state.upTo[type] ?? lastRound;
  const isLast = at === lastRound;

  const cut = state.slices[sliceKey(type, at)];
  if (!cut) {
    if (!wrap.innerHTML) wrap.innerHTML = '<div class="loading-state"><div class="spinner"></div> Загрузка…</div>';
    await fetchSlice(type, at);
    return renderTable(type);
  }
  const all = cut.standings;
  const prevRank = cut.prevRank;
  // участие считаем до выбранного этапа, иначе срез врёт про пропуски
  const starts = (kind, d) => [...(state.attendance[kind][d] || [])].filter(r => r <= at).length;
  const q = state.filter[type].toLowerCase();
  const filtered = q
    ? all.filter(s => s.driver.toLowerCase().includes(q) || s.team.toLowerCase().includes(q))
    : all;

  // Граница Чейза (топ-16), линия отсечки и «± Чейз» приходят из базы
  const isChase = isChaseMode(type, at);
  const gapCell = s => {
    if (s.gap == null) return '<span class="muted">—</span>';
    if (s.gap === 0) return '<span class="muted">0</span>';
    return `<span class="${s.gap > 0 ? 'up' : 'down'}">${s.gap > 0 ? '+' : ''}${s.gap}</span>`;
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
  ${at > CHASE_START ? `
  <div class="round-toggle inline">
    <button class="rtog-btn${!isChase ? ' rtog-active' : ''}" onclick="setChaseView('${type}','regular')">Регулярный сезон</button>
    <button class="rtog-btn${isChase ? ' rtog-active' : ''}" onclick="setChaseView('${type}','chase')">Чейз</button>
  </div>` : ''}
</div>`;
  // Если в шапке карточки есть свой контейнер под этот блок — рендерим туда,
  // а не внутрь тела таблицы (пока используется только для «Квалификации»)
  const uptoContainer = document.getElementById(`upto-${type}`);

  let html = uptoContainer ? '' : uptoHtml;
  html += `<div class="table-scroll"><table class="standings-table"><thead><tr>
${sortTh('rank', '#', '', 'r w-40')}
<th class="r w-44" title="Изменение места к прошлому этапу">±</th>
${sortTh('car', '#', 'title="Номер машины по последней проведённой гонке"', 'r w-44')}
${sortTh('driver', 'Гонщик', '', '')}
${sortTh('team', 'Команда', '', '')}
${sortTh('mfr', 'Авт.', '', '')}
${sortTh('total', 'Очки')}
${sortTh('chase', '± Чейз', 'title="В Чейзе — преимущество над первым вне Чейза; вне Чейза — отставание от последнего из Чейза"')}
${sortTh('wins', 'Победы', 'title="Количество побед (тай-брейк 1)"')}
${sortTh('starts', 'Гонок / Квал.', 'title="Проходов в гонку / участий в квалификации"')}
${sortTh('best', 'Лучш.')}
  </tr></thead><tbody>`;

  slice.forEach((s, i) => {
    // при своей сортировке места фиксированы: 1..n сверху вниз, место в зачёте — в тултипе;
    // у гостя (в т.ч. временного — сменил дивизион по листу Changes) места нет вообще
    const place = sort ? sortPlaceOf[(page - 1) * PAGE_SIZE + i] : s.rank;
    const inPlayoff = !!s.playoff;
    const isCutoff = !!s.cutoff;
    const rc = [
      place != null && place <= 3 ? `rank-${place}` : '',
      inPlayoff ? 'row-playoff' : '',
      isCutoff ? 'row-cutoff' : '',
    ].filter(Boolean).join(' ');

    const winsCell = s.wins > 0
      ? `<strong class="win">${s.wins}</strong>`
      : `<span class="muted">—</span>`;
    const tb = driverTooltip(s);
    html += `<tr class="${rc}" title="${tb}">
  <td class="r"><span class="pos-badge"${sort && place != null ? ` title="Место в зачёте: ${s.rank}"` : ''}>${place ?? '—'}</span></td>
  <td class="r">${s.isGuest ? '<span class="muted">—</span>' : deltaCell(prevRank[s.driver], s.rank)}</td>
  <td class="r">${carBadge(s.car, s.mfr)}</td>
  <td><strong class="driver-link" onclick="openDriver('${s.driver.replace(/'/g, "\\'").replace(/"/g, '&quot;')}'${/quals/i.test(type) ? ",'quals'" : ''})">${s.driver}</strong></td>
  <td class="team-text">${teamLink(s.team)}${coalMark(s.team)}</td>
  <td>${mfrBadge(s.mfr)}</td>
  <td class="r"><strong>${s.total}</strong></td>
  <td class="r">${gapCell(s)}</td>
  <td class="r">${winsCell}</td>
  <td class="r muted">${starts('races', s.driver)} / ${starts('quals', s.driver)}</td>
  <td class="r muted">${s.best == null ? '—' : 'P' + s.best}</td>
</tr>`;
  });

  html += '</tbody></table></div>'
    + paginationHtml(page, pages, `${rows.length} участников`, p => `goPage('${type}',${p})`);

  wrap.innerHTML = html;
  if (uptoContainer) uptoContainer.innerHTML = uptoHtml;
}

const SORT_KEYS = {
  rank: s => s.rank,
  car: s => (/^\d+$/.test(s.car) ? Number(s.car) : Infinity),
  driver: s => s.driver,
  team: s => s.team,
  mfr: s => s.mfr,
  total: s => s.total,
  chase: s => s.total,   // отрыв от границы Чейза — та же очерёдность, что и по очкам
  wins: s => s.wins,
  starts: s => state.attendance.races[s.driver]?.size || 0,
  best: s => s.best ?? Infinity,
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

// Имя листа и часть имени файла для каждого из четырёх личных зачётов
const STANDINGS_SHEET = { races: 'Зачёт гонок', quals: 'Зачёт квалификаций' };

// Выгружает весь зачёт целиком (тот же срез по этапу, что и на экране), а не только
// текущую страницу и не только строки, прошедшие поиск.
async function exportStandingsXLSX(type) {
  const rounds = roundsOf(type);
  const lastRound = rounds[rounds.length - 1];
  const at = state.upTo[type] ?? lastRound;
  const isLast = at === lastRound;
  const all = (await fetchSlice(type, at)).standings;
  const starts = (kind, d) => [...(state.attendance[kind][d] || [])].filter(r => r <= at).length;

  // «± Чейз» — тот же, что на экране: приходит из базы вместе со срезом
  const chaseGap = s => s.gap == null ? '' : s.gap > 0 ? `+${s.gap}` : String(s.gap);

  downloadTableXLSX(all, [
    ['#', s => s.rank],
    ['Номер', s => s.car],
    ['Гонщик', s => s.driver],
    ['Команда', s => s.team],
    ['Авт.', s => s.mfr],
    ['Очки', s => s.total],
    ['± Чейз', chaseGap],
    ['Победы', s => s.wins],
    ['Гонок', s => starts('races', s.driver)],
    ['Квал.', s => starts('quals', s.driver)],
    ['Лучш.', s => s.best ?? ''],
  ], STANDINGS_SHEET[type], `${exportSeriesLabel()} ${STANDINGS_SHEET[type].toLowerCase()}${isLast ? '' : ` после ${fmtRoundNum(at)} этапа`}.xlsx`);
}

function goPage(type, p) {
  state.page[type] = p;
  renderTable(type);
}

/* Сводная «пилот × этап» считается в базе (api.pivot): места по этапам, место в квале,
   итог строки. Грузится вместе с вкладкой; экспорт при необходимости дотягивает сам. */
async function pivotOf(type) {
  if (!state.pivotData) {
    const p = { season: state.year, division: state.division };
    state.pivotData = {
      races: await rpc('pivot', { ...p, session: 'race' }, state.fresh),
      quals: await rpc('pivot', { ...p, session: 'qual' }, state.fresh),
    };
  }
  return state.pivotData[type];
}

function renderPivot(type) {
  const wrap = document.getElementById(`pivot-${type}`);
  if (!state.pivotData) {
    pivotOf(type).then(() => renderPivot(type)).catch(err => console.error(err));
    return;
  }
  const { map, rounds, order, qualMap, rankOf, totals } = state.pivotData[type];
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
    const total = totals[driver] ?? 0;
      html += `<tr class="${rank != null && rank <= 3 ? 'rank-' + rank : ''}">
  <td class="driver-cell"><span class="pos-badge">${rank ?? '—'}</span> <span class="driver-link" onclick="openDriver('${jsArg(driver)}')">${driver}</span>${coalMark(teamOf(driver))}
  <div class="team-drivers">${teamLink(teamOf(driver))}</div></td>`;
    for (const r of rounds) {
      const pos = dmap[r];
      const qpos = qmap ? qmap[r] : null;
      const maxPos = state.roundMaxPos[r] || 40;
      // ключ есть, а места нет — дисквалификация; ключа нет — этап пропущен
      const raceCell = pos != null
        ? `<span class="pos-cell ${posClass(pos, maxPos)}">${pos}</span>`
        : r in dmap ? DQ_MARK : `<span class="pos-cell pos-none">—</span>`;
      const qualCell = qmap == null ? '' : qpos != null
        ? `<span class="pivot-qpos ${qpos <= maxPos ? 'up' : 'down'}">${qpos}</span>`
        : r in qmap ? DQ_MARK : `<span class="pivot-qpos pos-none">—</span>`;
      html += `<td>${raceCell}${qualCell}</td>`;
    }
    html += `<td class="total-cell">${total}</td></tr>`;
  }

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

/* Полный протокол сезона в .xlsx — как в официальной таблице: Pos/#/Пилот/Команда/Авт. + место
   на каждом этапе + итоговые очки, с заливкой ячеек по месту
   (жёлтый P1, серый топ-5, бронза топ-10, зелёный/фиолет ниже, красный — вне зачёта). */
const TOP3_FILL = ['FFE8A3', 'E0E0E0', 'EFD3B4'];

async function exportProtocolXLSX(type) {
  const { map, rounds } = await pivotOf(type);
  // Место и очки — по срезу, выбранному в интерфейсе («Зачёт после этапа» + Чейз),
  // а не всегда по итогу сезона; сетка позиций по этапам (map/rounds) при этом полная
  const roundsAvail = roundsOf(type);
  const at = state.upTo[type] ?? roundsAvail[roundsAvail.length - 1];
  const standings = (await fetchSlice(type, at)).standings;
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
  // вид в имени файла: иначе протоколы гонок и квалификаций сохраняются под одним именем
  downloadXLSX(wb, `${exportSeriesLabel()} протокол ${type === 'quals' ? 'квалификаций' : 'гонок'}.xlsx`);
}

function filterPivot(type, val) {
  state.pivot[type] = val;
  renderPivot(type);
}

/* ── Отыгранные / потерянные позиции: старт (квала) − финиш (гонка) за весь сезон.
   Считаются в базе (api.gains); дуэли не в счёт, этапы без одной из позиций пропускаются. ── */
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
  <td class="driver-cell"><span class="pos-badge">${g.rank}</span> <span class="driver-link" onclick="openDriver('${jsArg(g.driver)}')">${g.driver}</span>${coalMark(g.team)}
  <div class="team-drivers">${teamLink(g.team)}</div></td>`;
    for (const r of rounds) {
      const c = g.cells[r];
      html += c == null
        ? '<td><span class="pos-none">—</span></td>'
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
