/* KPI, загрузка данных и запуск */

function renderKPI(racesRows, qualsRows) {
  const rs = state.races.standings;
  const leader = rs[0];
  const second = rs[1];
  const numRaces = state.races.rounds.length;
  const numQuals = state.quals.rounds.filter(r => !SPRINT_ROUNDS.has(r)).length;
  const allDrivers = new Set([...racesRows, ...qualsRows].map(r => r['Driver']).filter(Boolean));
  const teams = new Set(racesRows.map(r => r['Team']).filter(Boolean));
  const gap = leader && second ? leader.total - second.total : 0;

  document.getElementById('kpi-grid').innerHTML = `
<div class="kpi-card">
  <div class="kpi-label">Лидер чемпионата</div>
  <div class="kpi-value sm">${leader.driver}</div>
  <div class="kpi-sub">${leader.team} &middot; ${leader.total} очков</div>
</div>
<div class="kpi-card green">
  <div class="kpi-label">Раундов завершено</div>
  <div class="kpi-value">${numRaces} / ${numQuals}</div>
  <div class="kpi-sub">гонок / квалификаций</div>
</div>
<div class="kpi-card blue">
  <div class="kpi-label">Участников</div>
  <div class="kpi-value">${allDrivers.size}</div>
  <div class="kpi-sub">${teams.size} команд</div>
</div>
<div class="kpi-card gold">
  <div class="kpi-label">Отрыв лидера от 2-го</div>
  <div class="kpi-value">+${gap}</div>
  <div class="kpi-sub">${second ? second.driver.split(' ').pop() + ' · ' + second.total + ' очков' : ''}</div>
</div>
  `;

  const upd = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('header-meta').textContent =
    `Дивизион ${DIVISIONS[state.division].label} · ${numRaces} гонок · ${numQuals} квалификаций · `
    + `${allDrivers.size} участников · ${teams.size} команд · обновлено ${upd}`;
}

async function init() {
  applyDivision();
  document.getElementById('kpi-grid').innerHTML =
    '<div class="kpi-card"><div class="loading-state"><div class="spinner"></div> Загрузка…</div></div>';
  try {
    await load();
  } catch (err) {
    document.getElementById('kpi-grid').innerHTML = `
  <div class="kpi-card" style="grid-column:1/-1;border-top-color:var(--accent)">
    <div class="kpi-label">Ошибка загрузки</div>
    <div class="kpi-value sm">${err.message}</div>
    <div class="kpi-sub" style="margin-top:10px">
      <button class="page-btn" onclick="init()">Повторить</button>
    </div>
  </div>`;
    document.getElementById('header-meta').textContent = 'Данные не загружены';
    console.error(err);
  }
}

async function load() {
  const div = DIVISIONS[state.division];
  const [racesRows, qualsRows, roundRows, coalRows, dedRows] = await Promise.all([
    fetchSheet(div.races),
    fetchSheet(div.quals),
    fetchSheet('Round'),
    div.coalitions ? fetchSheet(div.coalitions).catch(() => []) : [],
    fetchSheet('Deductions').catch(() => []),
  ]);

  // Лист без заголовка — берём первое значение строки
  state.coalitions = new Set(coalRows.map(r => Object.values(r)[0]).filter(Boolean));

  /* Штрафы команд в очках. Лист Deductions общий на оба дивизиона (как Round) и без столбца
     этапа, поэтому штраф считается сезонным: вычитается из командного зачёта на любой момент,
     в том числе в зачётах «после этапа» и в истории мест. До computeTeamStandings — она читает
     state.deductions. Пустого листа хватает, чтобы штрафов просто не было. */
  state.deductions = Object.fromEntries(
    dedRows.filter(r => r['Team'] && r['Points'] != null)
      .map(r => [r['Team'], { pts: r['Points'], reason: r['Reason'] || '' }]));

  // названия этапов нужны раньше вкладки «По этапам» — их показывает селектор среза зачёта
  state.roundNames = Object.fromEntries(
    roundRows.filter(r => r['#'] != null)
      .map(r => [String(r['#']), `${fmtRoundNum(r['#'])} · ${r['Name'] || ''}`]));

  state.roundAbb = Object.fromEntries(
    roundRows.filter(r => r['#'] != null && r['Abb.']).map(r => [String(r['#']), r['Abb.']])
  );

  // до любых зачётов: команда пилота берётся отсюда везде, где показывается
  state.teamOf = computeTeamOf(racesRows, qualsRows);

  const clashRows = qualsRows.filter(r => SPRINT_ROUNDS.has(parseFloat(r['Round'])));
  const racesRowsWithClash = [...racesRows, ...clashRows];

  state.races.rows = racesRows;
  state.races.rowsWithClash = racesRowsWithClash;
  state.races.standings = computeStandings(racesRowsWithClash);
  state.races.rounds = uniqueRounds(racesRows);
  state.quals.rows = qualsRows;
  state.quals.standings = computeStandings(qualsRows);
  state.quals.rounds = uniqueRounds(qualsRows);

  // Max race position per round (for colour coding)
  state.roundMaxPos = {};
  for (const r of racesRows) {
    const rnd = r['Round'], pos = r['Pos.'];
    if (rnd != null && pos != null)
      state.roundMaxPos[rnd] = Math.max(state.roundMaxPos[rnd] || 0, pos);
  }

  // Квалификация «по метрике»: прогнозов (DR1–DR4) нет, очки считаются метрикой — меньше лучше
  state.metricQuals = new Set(state.quals.rounds.filter(rnd =>
    qualsRows.filter(r => r['Round'] === rnd)
      .every(r => DR_KEYS.every(k => r[k] == null))));

  // Участие по этапам: проходы в гонку и участия в квалификации (клэши не в счёт)
  const countRounds = rows => {
    const m = {};
    for (const r of rows) {
      const d = r['Driver'], rnd = r['Round'];
      if (!d || rnd == null || SPRINT_ROUNDS.has(rnd)) continue;
      (m[d] ||= new Set()).add(rnd);
    }
    return m;
  };
  state.attendance = { races: countRounds(racesRows), quals: countRounds(qualsRows) };

  // Участие в квалификациях (без гостей и без клэшей — клэш не этап регулярного сезона, п. 11.1)
  state.qualsParticipation = {};
  for (const r of qualsRows) {
    const d = r['Driver'];
    const rnd = r['Round'];
    if (!d || d.includes('(i)') || rnd == null || SPRINT_ROUNDS.has(rnd)) continue;
    if (!state.qualsParticipation[d]) state.qualsParticipation[d] = new Set();
    state.qualsParticipation[d].add(rnd);
  }

  // Место в личном зачёте после каждого этапа — для графика в карточке пилота.
  // Граница как в renderRoundStandings: клэши относятся к своему этапу
  state.rankHistory = {};
  state.teamRankHistory = {};
  for (const rnd of state.races.rounds) {
    const upTo = racesRowsWithClash.filter(r => r['Round'] < rnd + 1);
    for (const s of computeStandings(upTo))
      (state.rankHistory[s.driver] ||= {})[rnd] = s.rank;
    for (const t of computeTeamStandings(upTo))
      (state.teamRankHistory[t.team] ||= {})[rnd] = t.rank;
  }

  // То же для зачёта квалификаций — график в карточке пилота в режиме «только квалы»
  state.qualRankHistory = {};
  for (const rnd of state.quals.rounds) {
    for (const s of computeStandings(qualsRows.filter(r => r['Round'] <= rnd)))
      (state.qualRankHistory[s.driver] ||= {})[rnd] = s.rank;
  }

  if (div.golub) state.golub = {
    races: computeGolub(racesRows),
    // квала по метрике — не прогноз, а замер: сравнивать по ней позиции нечестно
    quals: computeGolub(qualsRows.filter(r => !state.metricQuals.has(r['Round']))),
  };
  state.gains = computeGains();
  state.teamStandings = computeTeamStandings(racesRowsWithClash);
  // сводным нужны все команды, включая те, за которые ездили одни гости
  state.teamPivot = computeTeamStandings(racesRowsWithClash, true);
  state.ownerStandings = computeOwnerStandings(racesRowsWithClash);

  // Зачёты независимых команд (вне коалиций), места пересчитываются
  if (div.coalitions) {
    const rerank = arr => arr.map((x, i) => ({ ...x, rank: i + 1 }));
    const indep = team => team && team !== '—' && !state.coalitions.has(team);
    state.indRaces.standings = rerank(state.races.standings.filter(s => indep(s.team)));
    state.indQuals.standings = rerank(state.quals.standings.filter(s => indep(s.team)));
    state.indTeams = rerank(state.teamStandings.filter(t => indep(t.team)));
  }

  renderKPI(racesRows, qualsRows);

  renderTable('races');
  renderTable('quals');
  renderPivot('races');
  renderPivot('quals');
  renderTeamTab();
  renderOwners();
  if (div.coalitions) {
    renderTable('indRaces');
    renderTable('indQuals');
    renderIndTeams();
  }

  initCharts('races');
  initCharts('quals');
  initRoundView(roundRows);   // до сводных таблиц: оттуда берутся названия этапов
  if (div.golub) {
    renderGolub('races');
    renderGolub('quals');
  }
  renderGainPivot();
  renderTeamPivot();
  renderTeamPosPivot();
  applyHash();
}

init();
