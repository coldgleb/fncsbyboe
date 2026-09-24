/* Вкладка H2H: два пилота или две команды друг против друга.
   Счёт «кто выше» и строки по этапам считает local-api (rpc h2h), итоговые цифры
   пилотов — из уже загруженных зачётов, команд — из того же ответа. */

let h2hMode = 'drivers';

// Списки для выбора: пилоты — из зачётов гонок и квалификаций, команды — из сводной
function h2hOptions() {
  if (h2hMode === 'teams') return (state.h2hTeams || []).map(t => t.team);
  const names = new Set([...state.races.standings, ...state.quals.standings].map(s => s.driver));
  return [...names].sort((a, b) => a.localeCompare(b, 'ru'));
}

// По умолчанию — первые двое зачёта
function h2hDefaults() {
  const top = h2hMode === 'teams'
    ? (state.h2hTeams || []).filter(t => t.rank != null).map(t => t.team)
    : state.races.standings.filter(s => s.rank != null).map(s => s.driver);
  return [top[0], top[1]];
}

function fillH2hSelects() {
  const opts = h2hOptions();
  const [da, db] = h2hDefaults();
  for (const [id, def] of [['h2h-a', da], ['h2h-b', db]]) {
    const sel = document.getElementById(id);
    const keep = opts.includes(sel.value) ? sel.value : def;
    sel.innerHTML = opts.map(o => `<option value="${o.replace(/"/g, '&quot;')}"${o === keep ? ' selected' : ''}>${o.replace(' (i)', '')}</option>`).join('');
  }
}

function setH2hMode(mode) {
  h2hMode = mode;
  document.querySelectorAll('.rtog-btn[data-h2h]').forEach(b => b.classList.toggle('rtog-active', b.dataset.h2h === mode));
  document.getElementById('h2h-a').value = '';
  fillH2hSelects();
  renderH2h();
}

function initH2h() {
  fillH2hSelects();
  renderH2h();
}

// Строка сравнения: лучшее значение подсвечивается; lower — меньше лучше (место, средняя позиция),
// neutral — просто цифры без «кто лучше»
function h2hRow(label, va, vb, { lower = false, neutral = false, fmt = v => v ?? '—' } = {}) {
  const na = typeof va === 'number' ? va : parseFloat(va), nb = typeof vb === 'number' ? vb : parseFloat(vb);
  const ok = !neutral && isFinite(na) && isFinite(nb) && na !== nb;
  const aWins = ok && (lower ? na < nb : na > nb), bWins = ok && !aWins;
  return `<tr><td class="r${aWins ? ' h2h-win' : ''}">${fmt(va)}</td><td class="h2h-label">${label}</td><td${bWins ? ' class="h2h-win"' : ''}>${fmt(vb)}</td></tr>`;
}

// Шапка стороны: пилот — в цветах своей машины, команда — просто название
function h2hSide(name, align) {
  if (h2hMode === 'teams') return `<div class="h2h-side ${align}"><h2>${teamLink(name)}${coalMark(name)}</h2></div>`;
  const car = state.carOf?.[name]?.car;
  return `<div class="h2h-side ${align}${carHeadCls(car)}"${carHeadStyle(car)}>
  ${car ? carBadge(car, state.carOf[name].mfr).replace('car-badge', 'car-badge big') : ''}
  <div><h2>${driverLink(name)}</h2><div class="team-text">${teamLink(teamOf(name))}</div></div>
</div>`;
}

const h2hScore = (label, sc) => `<div class="h2h-score"><div class="k">${label}</div>
  <div class="v"><span class="${sc.a > sc.b ? 'h2h-win' : ''}">${sc.a}</span> : <span class="${sc.b > sc.a ? 'h2h-win' : ''}">${sc.b}</span></div></div>`;

// Подблок «Квалификации» / «Гонки»: счёт и показатели A | показатель | B
const h2hBlock = (title, score, rows) => `<div class="h2h-block">
  <h3 class="modal-stats-title">${title}</h3>
  ${score}
  <table class="h2h-stats"><tbody>${rows.join('')}</tbody></table>
</div>`;

const place = v => v == null ? '—' : '#' + v;
const bestP = v => v == null ? '—' : 'P' + v;

/* Пара ячеек A | B одного компонента. better(x, y) — x лучше y; первая ячейка пары
   получает разделитель слева, чтобы пары читались группами */
function h2hPair(va, vb, show, better) {
  const aWins = va != null && vb != null && better(va, vb), bWins = va != null && vb != null && better(vb, va);
  return `<td class="r pair-start${aWins ? ' h2h-win' : ''}">${show(va, 'a')}</td><td class="r${bWins ? ' h2h-win' : ''}">${show(vb, 'b')}</td>`;
}
const lowerBetter = (x, y) => x < y, higherBetter = (x, y) => x > y;

// Шапка таблицы по парам: сверху группа компонента, под ней короткие имена A и B
function h2hPairHead(groups, na, nb) {
  return `<tr class="grp-row"><th></th>${groups.map(g => `<th colspan="2" class="pair-start">${g}</th>`).join('')}</tr>
<tr><th>Этап</th>${groups.map(() => `<th class="r pair-start">${na}</th><th class="r">${nb}</th>`).join('')}</tr>`;
}

async function renderH2h() {
  const a = document.getElementById('h2h-a').value, b = document.getElementById('h2h-b').value;
  const body = document.getElementById('h2h-body');
  if (!a || !b) { body.innerHTML = '<div class="round-empty">Выберите двоих</div>'; return; }
  if (a === b) { body.innerHTML = '<div class="round-empty">Выберите разных</div>'; return; }
  const d = await rpc('h2h', { season: state.year, division: state.division, mode: h2hMode, a, b }, state.fresh);
  const teams = h2hMode === 'teams';

  let blocks, head, rows, cols;
  if (teams) {
    const teamRows = (x = {}, y = {}, winLabel) => [
      h2hRow('Место', x.rank, y.rank, { lower: true, fmt: place }),
      h2hRow('Очки', x.total, y.total),
      h2hRow('Этапов в зачёте', x.scored, y.scored),
      h2hRow(winLabel, x.wins, y.wins),
      h2hRow('Лучший', x.best, y.best, { lower: true, fmt: bestP }),
      h2hRow('Пилотов', x.drivers, y.drivers, { neutral: true }),
    ];
    blocks = h2hBlock('Квалификации', h2hScore('Этапов выиграно по очкам', d.quals.score), teamRows(d.quals.stats.a, d.quals.stats.b, 'Поулы'))
      + h2hBlock('Гонки', h2hScore('Этапов выиграно по очкам', d.races.score), teamRows(d.races.stats.a, d.races.stats.b, 'Победы'));
    head = h2hPairHead(['Места кв.', 'Очки кв.', 'Места гн.', 'Очки гн.'], a, b);
    cols = 9;
    // места команды за этап — зачётные (два лучших); сравниваются очками
    const posList = (p, rnd) => p?.length
      ? p.map(x => `<span class="pos-cell ${posClass(x, state.roundMaxPos[rnd] || 40)}">${x}</span>`).join(' ')
      : '<span class="muted">—</span>';
    const both = s => s && s.a.pos.length && s.b.pos.length;
    rows = d.rounds.map(r => `<tr><td>${roundFullName(r.round)}</td>
  ${h2hPair(r.qual?.a.pos, r.qual?.b.pos, v => posList(v, r.round), () => false)}
  ${h2hPair(both(r.qual) ? r.qual.a.pts : null, both(r.qual) ? r.qual.b.pts : null, (v, side) => (r.qual?.[side].pts || '—'), higherBetter)}
  ${h2hPair(r.race?.a.pos, r.race?.b.pos, v => posList(v, r.round), () => false)}
  ${h2hPair(both(r.race) ? r.race.a.pts : null, both(r.race) ? r.race.b.pts : null, (v, side) => (r.race?.[side].pts || '—'), higherBetter)}
</tr>`).join('');
  } else {
    const find = (list, n) => list.find(s => s.driver === n) || null;
    const [xr, yr, xq, yq] = [find(state.races.standings, a), find(state.races.standings, b), find(state.quals.standings, a), find(state.quals.standings, b)];
    const driverRows = (x, y, winLabel, bestLabel) => [
      h2hRow('Место', x?.rank, y?.rank, { lower: true, fmt: place }),
      h2hRow('Очки', x?.total, y?.total),
      h2hRow(winLabel, x?.wins, y?.wins),
      h2hRow(bestLabel, x?.best, y?.best, { lower: true, fmt: bestP }),
      h2hRow('Сред. поз.', x ? avgPos(x) : null, y ? avgPos(y) : null, { lower: true }),
      h2hRow('Топ-5', x?.top5, y?.top5),
      h2hRow('Топ-10', x?.top10, y?.top10),
    ];
    blocks = h2hBlock('Квалификации', h2hScore('Кто выше', d.quals), driverRows(xq, yq, 'Поулы', 'Лучший старт'))
      + h2hBlock('Гонки', h2hScore('Кто выше', d.races), driverRows(xr, yr, 'Победы', 'Лучший финиш'));
    const short = n => n.replace(' (i)', '').split(' ').pop();
    head = h2hPairHead(['Квала', 'Прогноз кв.', 'NASCAR кв.', 'Гонка', 'Прогноз гн.', 'NASCAR гн.'], short(a), short(b));
    cols = 13;
    const metric = new Set(d.metric);
    const guest = x => x?.guest ? ' <span class="guest-mark" title="Гостевая заявка">(i)</span>' : '';
    // место: нет строки — «—», строка без места — DQ
    const posShow = x => x ? (x.pos ?? DQ_MARK) + guest(x) : '<span class="muted">—</span>';
    const val = (x, k) => x ? x[k] : null;
    rows = d.rounds.map(r => {
      const m = metric.has(r.round);
      const mMark = m ? ' <span class="metric-mark" title="Квалификация по метрике: меньше очков — лучше">(metric)</span>' : '';
      const { qual: qa, race: ra } = r.a, { qual: qb, race: rb } = r.b;
      return `<tr><td>${roundFullName(r.round)}${mMark}</td>
  ${h2hPair(val(qa, 'pos'), val(qb, 'pos'), (v, side) => posShow(r[side].qual), lowerBetter)}
  ${h2hPair(val(qa, 'pts'), val(qb, 'pts'), v => v ?? '—', m ? lowerBetter : higherBetter)}
  ${h2hPair(qa && qb ? qa.nascar : null, qa && qb ? qb.nascar : null, (v, side) => r[side].qual?.nascar ?? '—', higherBetter)}
  ${h2hPair(val(ra, 'pos'), val(rb, 'pos'), (v, side) => posShow(r[side].race), lowerBetter)}
  ${h2hPair(val(ra, 'pts'), val(rb, 'pts'), v => v ?? '—', higherBetter)}
  ${h2hPair(ra && rb ? ra.nascar : null, ra && rb ? rb.nascar : null, (v, side) => r[side].race?.nascar ?? '—', higherBetter)}
</tr>`;
    }).join('');
  }

  body.innerHTML = `<div class="h2h-head">${h2hSide(a, 'left')}${h2hSide(b, 'right')}</div>
<div class="h2h-blocks">${blocks}</div>
<div class="chart-card"><h3>Место в ${teams ? 'командном' : 'личном'} зачёте после этапа</h3>
  <div class="chart-wrap sm"><canvas id="chart-h2h"></canvas></div></div>
<div class="table-scroll"><table class="standings-table h2h-rounds">
  <thead>${head}</thead>
  <tbody>${rows || `<tr><td colspan="${cols}" class="muted">Общих этапов нет</td></tr>`}</tbody>
</table></div>`;
  drawH2hChart(d.history, a, b);
}

// Две линии мест; цвета пилотов — их машины, если цвета совпали или их нет — из палитры
function drawH2hChart(hist, a, b) {
  const id = 'chart-h2h';
  if (state.charts[id]) state.charts[id].destroy();
  const rounds = state.races.rounds.filter(r => hist.a[r] != null || hist.b[r] != null);
  if (!rounds.length) { state.charts[id] = null; return; }
  let ca = h2hMode === 'drivers' ? carLineColor(state.carOf?.[a]?.car) : null;
  let cb = h2hMode === 'drivers' ? carLineColor(state.carOf?.[b]?.car) : null;
  if (!ca || !cb || ca === cb) [ca, cb] = [COLORS[0], COLORS[1]];

  const opts = lineChartOptions();
  opts.scales.y = { ...opts.scales.y, reverse: true, min: 1, ticks: { ...opts.scales.y.ticks, precision: 0 } };
  const ds = (label, h, color) => ({
    label: label.replace(' (i)', ''), data: rounds.map(r => h[r] ?? null),
    borderColor: color, backgroundColor: color + '20', tension: 0.35, pointRadius: 3, spanGaps: true,
  });
  state.charts[id] = new Chart(document.getElementById(id), {
    type: 'line',
    data: { labels: rounds.map(roundLabel), datasets: [ds(a, hist.a, ca), ds(b, hist.b, cb)] },
    options: opts,
  });
}
