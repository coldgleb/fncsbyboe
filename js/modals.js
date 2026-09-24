/* Карточки пилота и команды */

/* ── Карточка пилота ── */
/* Карточка пилота: итоговые цифры — из уже загруженного зачёта, строки по этапам и
   история мест — из базы (api.driver_card). mode = 'quals' — карточка из зачёта квал. */
async function openDriver(driver, mode) {
  const qualsOnly = mode === 'quals';
  const rs = state.races.standings.find(s => s.driver === driver);
  const qs = state.quals.standings.find(s => s.driver === driver);
  const base = (qualsOnly ? qs : rs) || rs || qs;
  if (!base) return;
  const card = await rpc('driver_card', {
    season: state.year, division: state.division, driver, mode: qualsOnly ? 'quals' : 'races',
  }, state.fresh);
  const rounds = card.rounds;

  // main — место и очки: крупнее и акцентом; остальные показатели — мельче
  const stat = (k, v, { sub = '', subTitle = '', main = false } = {}) => `<div class="modal-stat${main ? ' main' : ''}">
  <div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="sub" title="${subTitle}">${sub}</div>` : ''}</div>`;
  // гость в списке есть, а места нет: очки у него считаются, но вне основного зачёта
  const placeStat = s => !s || s.rank == null ? '—' : `#${s.rank}`;
  // гостевые заявки пилота со своими заявками — очки мимо зачёта, подписываем под очками
  const guestSub = g => g?.n
    ? ` <small title="Гостевые заявки: ${g.pts} очк. за ${g.n} эт. — мимо личного зачёта" style="white-space:nowrap">+${g.pts} (i)</small>` : '';
  // проведено этапов (без дуэлей) — знаменатель для стартов
  const held = kind => state[kind].rounds.filter(r => !SPRINT_ROUNDS.has(r)).length;
  // Блок «Гонки» / «Квалификации»: заголовок один, в подписях карточек сессия не повторяется
  const statBlock = (title, s, kind, g, winLabel, bestLabel) => `<div class="modal-stats-block">
  <h3 class="modal-stats-title">${title}</h3>
  <div class="modal-stats">${[
    // у гостя места нет: прочерк и подпись, а не «вне зачёта» крупным шрифтом
    stat('Место', placeStat(s), { main: true, ...(s && s.rank == null ? { sub: 'гость', subTitle: 'Очки считаются, но вне основного зачёта' } : {}) }),
    stat('Очки', (s ? s.total : '—') + guestSub(g), { main: true }),
    stat('Старты', `${state.attendance[kind][driver]?.size || 0} <small>/ ${held(kind)}</small>`),
    stat('Сред. поз.', s ? avgPos(s) : '—'),
    stat('Топ-5 · 10', s ? `${s.top5} · ${s.top10}` : '—'),
    // с победами (поулами) показываем их, без них информативнее лучший результат
    s && s.wins > 0 ? stat(winLabel, s.wins) : stat(bestLabel, s && s.best != null ? 'P' + s.best : '—'),
  ].join('')}</div>
</div>`;
  const raceStats = statBlock('Гонки', rs, 'races', card.guest?.races, 'Победы', 'Лучший');
  const qualStats = statBlock('Квалификации', qs, 'quals', card.guest?.quals, 'Поулы', 'Лучший');

  const metricMark = r => r.metric
    ? '<span class="metric-mark" title="Квалификация по метрике: без прогноза, меньше — лучше">(m)</span> ' : '';
  const place = (pos, dq) => pos ?? (dq ? DQ_MARK : '—');
  const roundLink = r => `<span class="driver-link" title="Открыть результаты этапа" onclick="goToRound(${Math.trunc(r.round)})">${roundFullName(r.round)}</span>`
    + (r.guest ? ` <span class="guest-mark" title="Гостевая заявка: ${r.counted
      ? 'очки считаются, но вне основного зачёта' : 'очки в личный зачёт не идут'}">(i)</span>` : '');
  // очки гостевой заявки, которые мимо личного зачёта, — в скобках и приглушённо
  const nascarCell = r => r.counted ? r.nascar
    : `<span class="muted" title="Мимо личного зачёта: гостевая заявка">(${r.nascar})</span>`;

  const body = rounds.map(r => qualsOnly ? `<tr>
  <td>${roundLink(r)}</td>
  <td class="r">${place(r.qualPos, r.qualDQ)}</td>
  <td class="r muted">${metricMark(r)}${r.qualPts ?? '—'}</td>
  <td class="r">${nascarCell(r)}</td>
</tr>` : `<tr>
  <td>${roundLink(r)}</td>
  <td class="r">${place(r.qualPos, r.qualDQ)}</td>
  <td class="r muted">${metricMark(r)}${r.qualPts ?? '—'}</td>
  <td class="r">${place(r.racePos, r.raceDQ)}</td>
  <td class="r muted">${r.racePts ?? '—'}</td>
  <td class="r">${r.diff == null ? '<span class="muted">—</span>' : r.diff === 0 ? '<span class="muted">0</span>'
    : `<span class="${r.diff > 0 ? 'up' : 'down'}">${r.diff > 0 ? '+' : ''}${r.diff}</span>`}</td>
  <td class="r">${nascarCell(r)}</td>
</tr>`).join('');

  const car = state.carOf?.[driver]?.car;
  document.getElementById('driver-modal-body').innerHTML = `
<div class="modal-head${carHeadCls(car)}"${carHeadStyle(car)}>
  ${car ? carBadge(car, base.mfr).replace('car-badge', 'car-badge big') : ''}
  <div class="modal-head-main">
    <h2>${driver.replace(' (i)', '')}${driver.includes(' (i)') ? ' <span class="guest-mark" title="Гостевой пилот">(i)</span>' : ''}</h2>
    <div class="team-text">${base.team}${coalMark(base.team)} ${mfrBadge(base.mfr)}</div>
  </div>
  <button class="modal-close" onclick="closeDriver()" title="Закрыть (Esc)">×</button>
</div>
${qualsOnly ? qualStats : `<div class="modal-stats-pair">${raceStats}${qualStats}</div>`}
<div class="chart-card">
  <h3>Место в ${qualsOnly ? 'зачёте квалификаций' : 'личном зачёте'} после этапа</h3>
  <div class="chart-wrap sm"><canvas id="chart-driver-rank"></canvas></div>
</div>
<div class="table-scroll"><table class="standings-table" data-sort="auto">
  <thead><tr>
    <th>Этап</th>
    <th class="r">Квала</th>
    <th class="r" title="Очки за прогноз в квалификации">Очки кв.</th>
    ${qualsOnly ? '' : `<th class="r">Гонка</th>
    <th class="r" title="Очки за прогноз в гонке">Очки гн.</th>
    <th class="r">±</th>`}
    <th class="r" title="${qualsOnly ? 'Очки в зачёт квалификаций' : 'Очки в зачёт (дуэли включены в Дейтону)'}">NASCAR</th>
  </tr></thead>
  <tbody>${body || `<tr><td colspan="${qualsOnly ? 4 : 7}" class="muted">Нет данных</td></tr>`}</tbody>
</table></div>
${rounds.some(r => r.metric)
      ? '<div class="modal-note"><span class="metric-mark">(m)</span> — квалификация по метрике: прогноза не было, меньше очков лучше</div>'
      : ''}`;
  document.getElementById('driver-modal').classList.add('open');
  const color = carLineColor(car) || MFR_COLORS[mfrKey(base.mfr)] || GRAY;
  qualsOnly
    ? drawRankChart(card.history || {}, color, state.quals.rounds.filter(r => r === Math.trunc(r)))
    : drawRankChart(card.history || {}, color);
}

/* Цвета машины (bg/fg с листа entries) в шапке карточек пилота и машины */
const carColorsOf = car => (car && state.carColors?.[car]) || null;
const carHeadCls = car => carColorsOf(car) ? ' car-colors' : '';
const carHeadStyle = car => {
  const c = carColorsOf(car);
  return c ? ` style="background:#${c.bg};color:#${c.fg}"` : '';
};
// линия графика — тем из цветов машины (bg или fg), что контрастнее фону страницы в текущей теме
function carLineColor(car) {
  const c = carColorsOf(car);
  if (!c) return null;
  const lum = h => [0, 2, 4].reduce((s, i) => s + parseInt(h.slice(i, i + 2), 16), 0) / 3;
  const page = document.documentElement.dataset.theme === 'light' ? 250 : 20;
  return '#' + (Math.abs(lum(c.bg) - page) >= Math.abs(lum(c.fg) - page) ? c.bg : c.fg);
}

// Фамилия — последнее слово имени, без гостевой метки
const surname = d => d.replace(' (i)', '').split(' ').pop();

/* ── Карточка машины (зачёт владельцев): тот же вид, что у пилота ── */
async function openCar(car) {
  const card = await rpc('car_card', { season: state.year, division: state.division, car }, state.fresh);
  const o = card.stats;
  const stat = (k, v, main = false) => `<div class="modal-stat${main ? ' main' : ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const stats = o ? [
    stat('Место', `#${o.rank}`, true),
    stat('Очки', o.total, true),
    stat('Старты', `${o.starts} <small>/ ${o.held}</small>`),
    stat('Сред. поз.', o.avg ?? '—'),
    stat('Топ-5 · 10', `${o.top5} · ${o.top10}`),
    o.wins > 0 ? stat('Победы', o.wins) : stat('Лучший', o.best != null ? 'P' + o.best : '—'),
  ].join('') : '';
  const place = (pos, dq) => pos ?? (dq ? DQ_MARK : '—');
  const guestMark = r => r.guest ? ' <span class="guest-mark" title="Гостевая заявка: очки машине идут">(i)</span>' : '';
  const body = card.rounds.map(r => `<tr>
  <td><span class="driver-link" title="Открыть результаты этапа" onclick="goToRound(${Math.trunc(r.round)})">${roundFullName(r.round)}</span></td>
  <td>${driverLink(r.driver)}${guestMark(r)}</td>
  <td class="r">${place(r.qualPos, r.qualDQ)}</td>
  <td class="r muted">${r.qualPts ?? '—'}</td>
  <td class="r">${place(r.racePos, r.raceDQ)}</td>
  <td class="r muted">${r.racePts ?? '—'}</td>
  <td class="r">${r.nascar ?? '—'}</td>
</tr>`).join('');

  document.getElementById('driver-modal-body').innerHTML = `
<div class="modal-head${carHeadCls(car)}"${carHeadStyle(car)}>
  ${carBadge(car, o?.mfr).replace('car-badge', 'car-badge big')}
  <div class="modal-head-main">
    <h2>Машина #${car}</h2>
    <div class="team-text">${o ? `${teamLink(o.team)}${coalMark(o.team)} ${mfrBadge(o.mfr)}` : ''}</div>
    <div class="team-text">${o ? o.drivers.slice().sort().map(driverLink).join(' · ') : ''}</div>
  </div>
  <button class="modal-close" onclick="closeDriver()" title="Закрыть (Esc)">×</button>
</div>
${o ? `<div class="modal-stats-block"><h3 class="modal-stats-title">Зачёт владельцев</h3><div class="modal-stats">${stats}</div></div>` : ''}
<div class="chart-card">
  <h3>Место в зачёте владельцев после этапа</h3>
  <div class="chart-wrap sm"><canvas id="chart-driver-rank"></canvas></div>
</div>
<div class="table-scroll"><table class="standings-table" data-sort="auto">
  <thead><tr>
    <th>Этап</th><th>Пилот</th>
    <th class="r">Квала</th><th class="r" title="Очки за прогноз в квалификации">Очки кв.</th>
    <th class="r">Гонка</th><th class="r" title="Очки за прогноз в гонке">Очки гн.</th>
    <th class="r" title="Очки машине в зачёт владельцев (дуэли — в итоге, не в строке этапа)">NASCAR</th>
  </tr></thead>
  <tbody>${body || '<tr><td colspan="7" class="muted">Нет данных</td></tr>'}</tbody>
</table></div>`;
  document.getElementById('driver-modal').classList.add('open');
  drawRankChart(card.history || {}, carLineColor(car) || MFR_COLORS[mfrKey(o?.mfr)] || GRAY);
}

// Ссылка на карточку команды — из любой таблицы
function teamLink(team) {
  if (!team || team === '—') return team || '—';
  return `<span class="driver-link" onclick="openTeam('${team.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')">${team}</span>`;
}

/* Карточка команды — та же всплывашка, что у пилота */
/* Карточка команды: всё по этапам (зачётные места, кто принёс, место на этапе, итог
   со штрафом, место в зачёте) — из базы, api.team_card */
async function openTeam(team) {
  const card = await rpc('team_card', { season: state.year, division: state.division, team }, state.fresh);
  const t = card.team;
  if (!t) return;
  const hist = card.history || {};
  const scored = card.rounds.filter(r => r.best.length);
  const best = t.bestPositions[0];
  const wins = t.bestPositions.filter(p => p === 1).length;

  const stat = (k, v) => `<div class="modal-stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  // метрика команды на последнем этапе: значение и место в метрике
  const m = card.metric;
  const metricStat = m && m.score != null
    ? `<div class="modal-stat"><div class="k">METRIC SCORE</div><div class="v" title="После ${roundFullName(m.round)}${m.ranked ? '' : ' · вне ранжирования'}">${m.score.toFixed(3)}${m.rank ? ` <span class="muted">#${m.rank}</span>` : ''}</div></div>`
    : '';
  const stats = [
    stat('Место', t.rank == null ? 'вне зачёта' : `#${t.rank}`),
    stat('Очки', `${penMark(t)}${t.total}`),
    metricStat,
    stat('Пилотов', t.drivers.length),
    stat('Этапов в зачёте', scored.length),
    stat('Лучший финиш', best != null ? 'P' + best : '—'),
    wins > 0 ? stat('Победы', wins) : stat('Сред. за этап', scored.length ? (t.total / scored.length).toFixed(1) : '—'),
  ].join('');

  const body = card.rounds.map(row => {
    const { round: r, best: bestOfRound, pts: got, rankInRound: rr, total: cum } = row;
    const maxPos = state.roundMaxPos[r] || 40;
    const cells = bestOfRound.length
      ? bestOfRound.map(x => `<span class="pos-cell ${posClass(x.pos, maxPos)}">${x.pos}</span>`).join(' ')
      : '<span class="muted">—</span>';
    return `<tr>
      <td><span class="driver-link" title="Открыть результаты этапа" onclick="goToRound(${r})">${roundFullName(r)}</span></td>
      <td>${cells}</td>
      <td class="team-text">${bestOfRound.map(x => driverLink(x.driver, null, surname(x.driver))).join(' · ') || '—'}</td>
      <td class="r">${got || '—'}</td>
      <td class="r">${rr == null ? '—' : `<span class="pos-badge">${rr}</span>`}</td>
      <td class="r"><strong>${cum}</strong></td>
      <td class="r">${row.rank ?? '—'}</td>
    </tr>`;
  }).join('');

  document.getElementById('driver-modal-body').innerHTML = `
<div class="modal-head">
  <div>
    <h2>${team}${coalMark(team)}</h2>
    <div class="team-text">${t.drivers.slice().sort().map(driverLink).join(' · ')}</div>
  </div>
  <button class="modal-close" onclick="closeDriver()" title="Закрыть (Esc)">×</button>
</div>
<div class="modal-stats">${stats}</div>
<div class="chart-card">
  <h3>Место в командном зачёте после этапа</h3>
  <div class="chart-wrap sm"><canvas id="chart-driver-rank"></canvas></div>
</div>
<div class="table-scroll"><table class="standings-table" data-sort="auto">
  <thead><tr>
    <th>Этап</th>
    <th title="Два лучших результата команды на этапе">Зачётные места</th>
    <th>Кто принёс</th>
    <th class="r">Очки</th>
    <th class="r" title="Место команды на этапе — по очкам, набранным на нём">На этапе</th>
    <th class="r">Всего</th>
    <th class="r" title="Место в командном зачёте после этапа">Место</th>
  </tr></thead>
  <tbody>${body || '<tr><td colspan="7" class="muted">Нет данных</td></tr>'}</tbody>
</table></div>`;
  document.getElementById('driver-modal').classList.add('open');
  drawRankChart(hist, GRAY);
}

function closeDriver() {
  document.getElementById('driver-modal').classList.remove('open');
}

// Из карточки пилота — к результатам этапа
// view — какой протокол открыть: 'race' (по умолчанию) или 'qual'
function goToRound(n, view = 'race') {
  const val = String(n);
  closeDriver();
  switchTab('rounds');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  // селектор этапов заполняется при первом открытии вкладки — ждём его и выбираем этап
  ensureTab('rounds').then(() => {
    const sel = document.getElementById('round-select');
    if (!sel || ![...sel.options].some(o => o.value === val)) return;
    sel.value = val;
    roundView = view;
    onRoundChange();
  }).catch(err => console.error(err));
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDriver(); });
