/* KPI, загрузка данных и запуск */

/* Шапка: плитки — дивизион, гонок, квалификаций, участников, команд */
function renderKPI() {
  const { numRaces, numQuals, drivers, teams } = state.kpi;
  const card = (label, value) => `<div class="kpi-card">
  <div class="kpi-label">${label}</div>
  <div class="kpi-value">${value}</div>
</div>`;
  document.getElementById('kpi-grid').innerHTML = [
    card('Дивизион', DIVISIONS[state.division].label),
    card('Гонок', numRaces),
    card('Квалификаций', numQuals),
    card('Участников', drivers),
    card('Команд', teams),
  ].join('');
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
  state.carColors = m.carColors || {};
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
      renderTop5().catch(console.error);
      // сводные и графики ниже по странице: по одной, не задерживая таблицу
      (async () => {
        const [races, quals] = [await rpc('pivot', { ...p, session: 'race' }, fresh),
          await rpc('pivot', { ...p, session: 'qual' }, fresh)];
        state.pivotData = { races, quals };
        renderPivot('races');
        renderPivot('quals');
        state.gains = await rpc('gains', p, fresh);
        renderGainPivot();
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
      // метрика считается на каждый этап, поэтому строки берём только на нужный срез
      state.metric = await rpc('metric', { ...p, upto: state.entriesUpTo ?? undefined }, fresh);
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

    if (tab === 'h2h') {
      // список команд для режима «Команды» — сводная, включая команды из одних гостей
      state.h2hTeams = await rpc('team_standings', { ...p, upto: 1000, with_guest_only: true }, fresh);
      initH2h();
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

/* Топ-5 последнего этапа — квалификация и гонка, над итоговыми таблицами обеих вкладок.
   Место, участник, команда и очки за прогноз из протокола этапа (DQ без места не показываем). */
async function renderTop5() {
  const last = rounds => rounds.filter(r => !SPRINT_ROUNDS.has(r) && r !== 0).pop();
  const card = async (view, round, title) => {
    if (round == null) return '';
    const { rows, metric } = await rpc('round_protocol', { ...season(), round, view }, state.fresh);
    const top = rows.filter(r => r['Pos.'] != null).slice(0, 5);
    return `<div class="table-card top5-card">
  <div class="table-header"><h3><span class="driver-link" title="Открыть протокол этапа" onclick="goToRound(${round}, '${view}')">${title} · ${roundFullName(round)}</span></h3></div>
  <div class="table-scroll"><table class="standings-table top5"><thead><tr>
    <th class="r w-40">#</th><th class="r w-44">№</th><th>Участник</th><th>Команда</th>
    <th class="r" title="Очки за прогноз${metric ? ' — квала по метрике: меньше лучше' : ''}">Очки${metric ? ' <span class="metric-mark">(m)</span>' : ''}</th>
  </tr></thead><tbody>${top.map(r => `<tr class="${r['Pos.'] <= 3 ? 'rank-' + r['Pos.'] : ''}">
    <td class="r"><span class="pos-badge">${r['Pos.']}</span></td>
    <td class="r">${carBadge(r['#'], r['M.'])}</td>
    <td><strong>${driverLink(r['Driver'])}</strong></td>
    <td class="team-text">${teamLink(r['Team'])}${coalMark(r['Team'])}</td>
    <td class="r"><strong>${r['Points'] ?? '—'}</strong></td></tr>`).join('')}</tbody></table></div>
</div>`;
  };
  const html = (await card('qual', last(state.quals.rounds), 'Квалификация'))
    + (await card('race', last(state.races.rounds), 'Гонка'));
  for (const t of ['races', 'quals']) document.getElementById(`top5-${t}`).innerHTML = html;
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
  const btn = document.getElementById('theme-btn');
  btn.textContent = dark ? '☀' : '☾';
  btn.title = dark ? 'Светлая тема' : 'Тёмная тема';
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch (e) { }
  syncThemeBtn();
}

syncThemeBtn();
init();
