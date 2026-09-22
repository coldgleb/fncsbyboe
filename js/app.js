/* KPI, загрузка данных и запуск */

function renderKPI() {
  const { leader, second, numRaces, numQuals, gap } = state.kpi;
  const allDrivers = { size: state.kpi.drivers };
  const teams = { size: state.kpi.teams };

  document.getElementById('kpi-grid').innerHTML = `
<div class="kpi-card">
  <div class="kpi-label">Лидер чемпионата</div>
  <div class="kpi-value sm">${leader.driver}</div>
  <div class="kpi-sub">${leader.team} &middot; ${leader.total} очков</div>
</div>
<div class="kpi-card">
  <div class="kpi-label">Раундов завершено</div>
  <div class="kpi-value">${numRaces} / ${numQuals}</div>
  <div class="kpi-sub">гонок / квалификаций</div>
</div>
<div class="kpi-card">
  <div class="kpi-label">Участников</div>
  <div class="kpi-value">${allDrivers.size}</div>
  <div class="kpi-sub">${teams.size} команд</div>
</div>
<div class="kpi-card">
  <div class="kpi-label">Отрыв лидера от 2-го</div>
  <div class="kpi-value">+${gap}</div>
  <div class="kpi-sub">${second ? second.driver.split(' ').pop() + ' · ' + second.total + ' очков' : ''}</div>
</div>
  `;

  // у кэшированных листов показываем время их загрузки, а не «сейчас»
  const upd = new Date(state.dataTs ?? Date.now()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('header-meta').textContent =
    `Дивизион ${DIVISIONS[state.division].label} · ${numRaces} гонок · ${numQuals} квалификаций · `
    + `${allDrivers.size} участников · ${teams.size} команд · обновлено ${upd}`;
}

async function init(fresh) {
  initYearSelect();
  applyDivision();
  document.getElementById('kpi-grid').innerHTML =
    '<div class="kpi-card"><div class="loading-state"><div class="spinner"></div> Загрузка…</div></div>';
  try {
    await load(fresh);
  } catch (err) {
    document.getElementById('kpi-grid').innerHTML = `
  <div class="kpi-card wide">
    <div class="kpi-label">Ошибка загрузки</div>
    <div class="kpi-value sm">${err.message}</div>
    <div class="kpi-sub">
      <button class="page-btn" onclick="init(true)">Повторить</button>
    </div>
  </div>`;
    document.getElementById('header-meta').textContent = 'Данные не загружены';
    console.error(err);
  }
}

/* ── Загрузка ──
   Все таблицы считает PostgreSQL (схема api, db/api.sql); сайт вызывает её функции
   и только показывает результат. На старте — сводка сезона и таблица открытой
   вкладки; остальное — когда вкладку действительно открыли. */
const setsOf = m => Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [k, new Set(v)]));
const season = () => ({ season: state.year, division: state.division });

function applyMain(m) {
  state.kpi = m.kpi;
  state.races.rounds = m.rounds.races || [];
  state.quals.rounds = m.rounds.quals || [];
  state.races.standings = m.standings.races;
  state.quals.standings = m.standings.quals;
  state.protocolRounds = m.protocolRounds || [];
  state.roundNames = m.roundNames || {};
  state.roundAbb = m.roundAbb || {};
  state.metricQuals = new Set(m.metricQuals);
  state.coalitions = new Set(m.coalitions);
  state.guestByChange = new Set(m.guestByChange);
  state.deductions = m.deductions;
  state.teamOf = m.teamOf;
  state.carOf = m.carOf || {};
  state.roundMaxPos = m.roundMaxPos;
  state.attendance = { races: setsOf(m.attendance.races), quals: setsOf(m.attendance.quals) };
  state.qualsParticipation = setsOf(m.qualsParticipation);
}

// какие вкладки уже наполнены — чтобы не дёргать сервер повторно
let tabReady = {};

async function load(fresh) {
  state.dataTs = null;
  state.fresh = !!fresh;          // вкладки, открытые после «Обновить», тоже идут мимо кэша
  tabReady = {};
  state.slices = {};
  state.pivotData = null;

  applyMain(await rpc('season_summary', season(), fresh));
  renderKPI();

  const tab = document.querySelector('.tab-btn.active')?.dataset.tab || 'races';
  await ensureTab(tab, fresh);
  applyHash();
}

/* Наполнение вкладки: запрашиваем ровно то, что ей нужно. Повторный заход — из кэша. */
async function ensureTab(tab, fresh = state.fresh) {
  if (tabReady[tab]) return;
  tabReady[tab] = true;
  const p = season();

  try {
    if (tab === 'races' || tab === 'quals') {
      await renderTable(tab);
      // сводные и графики ниже по странице: по одной, не задерживая таблицу
      (async () => {
        const [races, quals] = [await rpc('pivot', { ...p, session: 'race' }, fresh),
          await rpc('pivot', { ...p, session: 'qual' }, fresh)];
        state.pivotData = { races, quals };
        renderPivot('races');
        renderPivot('quals');
        state.gains = await rpc('gains', p, fresh);
        renderGainPivot();
        state.races.chartStandings = await rpc('chart_points', { ...p, session: 'race' }, fresh);
        state.quals.chartStandings = await rpc('chart_points', { ...p, session: 'qual' }, fresh);
        initCharts('races');
        initCharts('quals');
      })().catch(console.error);
      return;
    }

    if (tab === 'teams') {
      state.teamStandings = await rpc('team_standings', { ...p, upto: 1000 }, fresh);
      state.teamPivot = await rpc('team_standings', { ...p, upto: 1000, with_guest_only: true }, fresh);
      renderTeamTab();
      renderTeamPivot();
      renderTeamPosPivot();
      return;
    }

    if (tab === 'owners') { await renderOwners(); return; }

    if (tab === 'entries') {
      state.metric = await rpc('metric', p, fresh);
      renderEntries();
      return;
    }

    if (tab === 'golub') {
      state.golub = {
        races: await rpc('golub', { ...p, session: 'race' }, fresh),
        quals: await rpc('golub', { ...p, session: 'qual' }, fresh),
      };
      renderGolub('races');
      renderGolub('quals');
      return;
    }

    if (tab === 'calc') {
      if (typeof calcLoadSheets === 'function') calcLoadSheets();
      return;
    }

    if (tab === 'rounds') {
      initRoundView();
      return;
    }
  } catch (err) {
    tabReady[tab] = false;
    throw err;
  }
}

/* Кнопка «Обновить»: выбрасываем кэш листов и тянем свежие данные */
function refreshData() {
  cacheClear();
  init(true);
}

/* ── Тема: тёмная (база) / светлая. Графики Chart.js читают цвета из CSS-переменных,
   поэтому после смены темы их надо пересобрать ── */
function syncThemeBtn() {
  const dark = document.documentElement.dataset.theme !== 'light';
  document.getElementById('theme-btn').textContent = dark ? '☀ Светлая' : '☾ Тёмная';
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch (e) { }
  syncThemeBtn();
  if (state.races.standings.length) { initCharts('races'); initCharts('quals'); }
}

syncThemeBtn();
init();
