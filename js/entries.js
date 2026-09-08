/* Заявки: сводная статистика команд на выбранный срез сезона.

   Лист Entries — матрица «команда × машина × этап» с единицей там, где машина заявлена;
   первая строка — номера этапов, вторая — подписи Team/Car (настоящей шапки у листа нет).
   Из него считается блок FULL TIME PARTICIPATION: там только фулл-тайм машины — заявленные
   подряд с момента заявления и до конца сезона. Остальные блоки считаются по всем прогнозам
   команды: и фулл-тайм, и парт-тайм машины, и гостевые пилоты — всё, что подано от её имени.

   Везде считаются только этапы регулярного сезона: дуэли и The Clash (этап 0) не в счёт. */

function computeEntries(rows) {
  if (rows.length < 3) return null;
  const head = rows[0];
  const [teamKey, carKey] = Object.keys(head);
  const roundCols = Object.entries(head).filter(([, v]) => typeof v === 'number');
  const lastCol = Math.max(...roundCols.map(([, rnd]) => rnd));

  const byTeam = {};
  for (const r of rows.slice(1)) {
    const team = r[teamKey];
    if (!team || team === 'Team') continue;     // строка подписей Team/Car
    const on = roundCols.filter(([col]) => r[col]).map(([, rnd]) => rnd);
    if (!on.length) continue;
    // ponytail: фулл-тайм определяем по самому листу — сплошной ряд до последнего столбца сезона.
    // Если машину снимут с фулл-тайма посреди сезона, её придётся помечать в листе явно
    const last = on[on.length - 1];
    if (last !== lastCol || on.length !== last - on[0] + 1) continue;
    (byTeam[team] ||= {})[String(r[carKey])] = new Set(on);
  }
  return byTeam;
}

// Этап идёт в статистику: дуэль — не этап регулярного сезона, этап 0 (The Clash) вне зачёта
const statRound = (rnd, at) => rnd != null && rnd !== 0 && !SPRINT_ROUNDS.has(rnd) && rnd <= at;

/* Фактически поданные прогнозы по фулл-тайм машинам: строка в квалификации = поданный прогноз
   (в гонку попадают не все). Считаем по номеру машины, иначе в факт попадёт и парт-тайм. */
function factByTeamRound() {
  const m = {};
  for (const r of state.quals.rows) {
    const team = r['Team'], rnd = r['Round'];
    if (!team || rnd == null || rnd === 0 || SPRINT_ROUNDS.has(rnd)) continue;
    if (!state.entries[team]?.[String(r['#'])]?.has(rnd)) continue;
    const t = (m[team] ||= {});
    t[rnd] = (t[rnd] || 0) + 1;
  }
  return m;
}

// План: сколько прогнозов фулл-тайм машины команды должны были подать к этапу at
function planByTeam(team, upToRounds) {
  return Object.values(state.entries[team])
    .reduce((n, rounds) => n + upToRounds.filter(r => rounds.has(r)).length, 0);
}

const ZERO_STATS = {
  entriesTotal: 0, realQuals: 0, qPosSum: 0, qPosN: 0, top10Q: 0,
  starts: 0, rPosSum: 0, rPosN: 0, top10R: 0, wins: 0,
};

/* Пилот может квалифицироваться гостем без машины, а стартовать уже за команду — в листе квалификаций
   у такой строки Team = «Guest entry», а в листе гонок на том же этапе стоит настоящая команда.
   Прогноз при этом подан от её имени, поэтому берём команду из гоночной строки того же этапа. */
function raceTeamByRound() {
  const m = {};
  for (const r of state.races.rows) {
    const team = r['Team'], d = r['Driver'], rnd = r['Round'];
    if (!d || !team || team === '—' || team === 'Guest entry' || rnd == null) continue;
    (m[d] ||= {})[rnd] = team;
  }
  return m;
}

/* Статистика по всем прогнозам команды. Соревновательная квалификация — та, что не по метрике
   (DR1–DR4 заполнены); метричные этапы уже лежат в state.metricQuals.
   DQ (строка есть, места нет) считается поданным прогнозом и стартом, но в средние и топ-10
   не идёт — позиции у неё просто нет. */
function teamStats(at) {
  const stats = {};
  const of = team => (stats[team] ||= { ...ZERO_STATS });
  const raceTeams = raceTeamByRound();

  for (const r of state.quals.rows) {
    const rnd = r['Round'];
    const team = r['Team'] === 'Guest entry' ? raceTeams[r['Driver']]?.[rnd] : r['Team'];
    if (!team || !statRound(rnd, at)) continue;
    const s = of(team);
    s.entriesTotal++;
    if (state.metricQuals.has(rnd)) continue;
    s.realQuals++;
    const pos = r['Pos.'];
    if (pos == null) continue;
    s.qPosSum += pos;
    s.qPosN++;
    if (pos <= 10) s.top10Q++;
  }

  for (const r of state.races.rows) {
    const team = r['Team'], rnd = r['Round'];
    if (!team || !statRound(rnd, at)) continue;
    const s = of(team);
    s.starts++;
    const pos = r['Pos.'];
    if (pos == null) continue;
    s.rPosSum += pos;
    s.rPosN++;
    if (pos <= 10) s.top10R++;
    if (pos === 1) s.wins++;
  }
  return stats;
}

/* Ранг с общими местами: при равенстве все получают наименьший (лучший) ранг, а следующий
   сдвигается на размер группы — 3 победы и три команды по 2 дают ранги 1, 2, 2, 2, 5.
   Команды без значения («—») не ранжируются и на чужие ранги не влияют.
   ponytail: квадратичный перебор, но команд десятки — сортировать ради этого нечего. */
function rankBy(rows, key, best = 'max') {
  const better = (v, x) => best === 'max' ? v > x : v < x;
  for (const r of rows) {
    r[key + 'Rank'] = r[key] == null ? null
      : 1 + rows.filter(o => o[key] != null && better(o[key], r[key])).length;
  }
}

const pctOf = (a, b) => b ? a / b * 100 : null;
const avgOf = (sum, n) => n ? sum / n : null;

/* METRIC SCORE — свёртка рангов команды в одно число, меньше — лучше.
   Базовая метрика: ранг по каждому фактору умножается на его вес, произведения складываются.
   Финальная: базовая корректируется на участие фулл-тайм машин — пропуски штрафуют,
   100% участия оставляет метрику как есть (множитель 1 + (1 − ENTRIES %)).
   Без хотя бы одного ранга или без плановых заявок метрика не считается — в таблице «—». */
const METRIC_WEIGHTS = [
  ['avgQRank', 0.10], ['top10QPctRank', 0.10], ['startsPctRank', 0.15],
  ['avgRRank', 0.20], ['top10RPctRank', 0.20], ['winsRank', 0.10], ['teamPtsRank', 0.15],
];

/* Ценз участия: команда с ENTRIES % ниже 45 в ранжировании не участвует вовсе — ни своих
   рангов, ни метрики, и на ранги остальных она не влияет. */
const METRIC_MIN_ENTRIES = 45;
const isRanked = t => t.pct != null && t.pct >= METRIC_MIN_ENTRIES;

function metricScore(t) {
  if (t.pct == null || METRIC_WEIGHTS.some(([key]) => t[key] == null)) return null;
  const base = METRIC_WEIGHTS.reduce((sum, [key, w]) => sum + t[key] * w, 0);
  return base * (1 + (1 - t.pct / 100));
}

/* Срезы, на которые считается таблица: не каждый этап подряд, а контрольные точки сезона.
   Сама статистика при этом считается по всем этапам до выбранного, а не только по этим трём. */
const ENTRIES_CHECKPOINTS = [20, 26, 27];

function entriesRounds() {
  const held = roundsOf('quals');
  const checkpoints = held.filter(r => ENTRIES_CHECKPOINTS.includes(r));
  return checkpoints.length ? checkpoints : held.slice(-1);   // ни одной точки ещё не прошло
}

function entriesRows(at) {
  const upToRounds = roundsOf('quals').filter(r => r <= at);
  const fact = factByTeamRound();
  const stats = teamStats(at);
  // командный зачёт на тот же срез: дуэли и этап 0 computeTeamStandings отсекает сама
  const teamPts = Object.fromEntries(
    computeTeamStandings(state.races.rows.filter(r => r['Round'] <= at)).map(t => [t.team, t.total]));

  const rows = Object.keys(state.entries)
    .map(team => {
      const s = { ...ZERO_STATS, ...stats[team] };
      const plan = planByTeam(team, upToRounds);
      const made = upToRounds.reduce((n, r) => n + (fact[team]?.[r] || 0), 0);
      return {
        team,
        entriesTotal: s.entriesTotal,
        realQuals: s.realQuals,
        avgQ: avgOf(s.qPosSum, s.qPosN),
        top10Q: s.top10Q,
        top10QPct: pctOf(s.top10Q, s.realQuals),
        starts: s.starts,
        startsPct: pctOf(s.starts, s.entriesTotal),
        avgR: avgOf(s.rPosSum, s.rPosN),
        top10R: s.top10R,
        top10RPct: pctOf(s.top10R, s.starts),
        wins: s.wins,
        teamPts: teamPts[team] ?? 0,
        made, plan, pct: pctOf(made, plan),
      };
    })
    .filter(t => t.plan || t.entriesTotal);     // команда к этому этапу ещё не заявлялась

  // ранги строятся только по прошедшим ценз; остальные остаются вовсе без рангов
  const ranked = rows.filter(isRanked);
  rankBy(ranked, 'avgQ', 'min');
  rankBy(ranked, 'top10QPct');
  rankBy(ranked, 'startsPct');
  rankBy(ranked, 'avgR', 'min');
  rankBy(ranked, 'top10RPct');
  rankBy(ranked, 'wins');
  rankBy(ranked, 'teamPts');
  for (const t of rows) t.metric = metricScore(t);

  // по умолчанию — по метрике, меньше лучше; команды без метрики уходят вниз
  return rows
    .sort((a, b) => (a.metric ?? Infinity) - (b.metric ?? Infinity) || b.teamPts - a.teamPts)
    .map((t, i) => ({ ...t, rank: i + 1 }));
}

/* Столбцы: [заголовок, значение строки, подсказка]. Один список на экран и на выгрузку,
   чтобы Excel не разъезжался с таблицей. */
const numCell = v => v == null ? '—' : String(v);
const avgCell = v => v == null ? '—' : v.toFixed(2);
const pctCell = v => v == null ? '—' : v.toFixed(1) + '%';

const ENTRIES_GROUPS = [['METRIC', 1], ['QUALS', 7], ['RACES', 8], ['WINS', 2], ['TEAMS', 2], ['FULL TIME PARTICIPATION', 3]];

const ENTRIES_COLS = [
  ['METRIC SCORE', t => t.metric == null ? '—' : t.metric.toFixed(3),
    `Свёртка рангов с весами (AVG Q 10%, TOP 10 Q % 10%, STARTS % 15%, AVG R 20%, TOP 10 R % 20%, WINS 10%, TEAMS 15%), скорректированная на участие фулл-тайм машин. Меньше — лучше. Ранги и метрика считаются только у команд с ENTRIES % не ниже ${METRIC_MIN_ENTRIES}`],
  ['ENTRIES TOTAL', t => numCell(t.entriesTotal), 'Общее количество поданных прогнозов от имени пилотов команды, как фулл-тайм, так и парт-тайм'],
  ['REAL QUALS', t => numCell(t.realQuals), 'Прогнозы, участвовавшие в соревновательной квалификации, то есть за вычетом этапов по метрике'],
  ['AVG Q', t => avgCell(t.avgQ), 'Средняя квалификационная позиция для соревновательных прогнозов, вне зависимости от попадания в топ-40'],
  ['AVG Q RANK', t => numCell(t.avgQRank), 'Ранг по средней позиции в соревновательной квалификации: чем лучше средняя — тем выше ранг'],
  ['TOP 10 Q', t => numCell(t.top10Q), 'Попадания в топ-10 соревновательной квалификации'],
  ['TOP 10 Q %', t => pctCell(t.top10QPct), 'Доля попаданий в топ-10 от числа соревновательных прогнозов (REAL QUALS)'],
  ['TOP 10 Q % RANK', t => numCell(t.top10QPctRank), 'Ранг по доле попаданий в топ-10 соревновательной квалификации'],
  ['STARTS', t => numCell(t.starts), 'Проходы на старт гонки: через соревновательную квалификацию и по метрике'],
  ['STARTS %', t => pctCell(t.startsPct), 'Доля проходов на старт от всех поданных прогнозов (ENTRIES TOTAL)'],
  ['STARTS % RANK', t => numCell(t.startsPctRank), 'Ранг по доле проходов на старт'],
  ['AVG R', t => avgCell(t.avgR), 'Средняя финишная позиция в гонке; непопадания на старт не учитываются'],
  ['AVG R RANK', t => numCell(t.avgRRank), 'Ранг по средней финишной позиции: чем лучше средняя — тем выше ранг'],
  ['TOP 10 R', t => numCell(t.top10R), 'Попадания в топ-10 в гонке'],
  ['TOP 10 R %', t => pctCell(t.top10RPct), 'Доля попаданий в топ-10 гонки от числа проходов на старт'],
  ['TOP 10 R % RANK', t => numCell(t.top10RPctRank), 'Ранг по доле попаданий в топ-10 гонки'],
  ['WINS', t => numCell(t.wins), 'Победы в гонках у пилотов команды'],
  ['WINS RANK', t => numCell(t.winsRank), 'Ранг по числу побед'],
  ['TEAM PTS', t => numCell(t.teamPts), 'Очки в командном зачёте: не более двух лучших финишей от команды за гонку, штрафы вычтены'],
  ['TEAMS RANK', t => numCell(t.teamPtsRank), 'Ранг по очкам в командном зачёте'],
  ['ENTRIES FACT', t => numCell(t.made), 'Фактически поданные прогнозы за фулл-тайм машины команды, с учётом пропущенных этапов'],
  ['ENTRIES PLAN', t => numCell(t.plan), 'Плановое число прогнозов за фулл-тайм машины: этапы с момента заявления каждой машины'],
  ['ENTRIES %', t => pctCell(t.pct), 'Доля участия фулл-тайм машин: ENTRIES FACT делённое на ENTRIES PLAN'],
];

// Выделяем только ранги и итоговую метрику — сами значения идут фоном, приглушённо
const colClass = label => label === 'METRIC SCORE' ? 'metric-col'
  : label.endsWith('RANK') ? 'rank-col' : 'val-col';

function renderEntries() {
  const rounds = entriesRounds();
  const at = state.entriesUpTo ?? rounds[rounds.length - 1];
  const rows = entriesRows(at).filter(t => hit(state.entriesFilter, t.team));

  let html = `<div class="table-upto">
  <label>По состоянию на этап:
    <select class="chart-select" onchange="setEntriesUpTo(this.value)">
      ${rounds.map(r => `<option value="${r}"${r === at ? ' selected' : ''}>${roundFullName(r)}</option>`).join('')}
    </select>
  </label>
  <span class="upto-note">FULL TIME PARTICIPATION — только фулл-тайм машины, остальное — по всем прогнозам команды</span>
</div>
<div class="pivot-scroll"><table class="pivot-table entries-table" data-sort="auto">
<thead>
<tr class="grp-row"><th colspan="2"></th>${ENTRIES_GROUPS.map(([g, n]) => `<th colspan="${n}">${g}</th>`).join('')}</tr>
<tr><th class="num-col">#</th><th class="driver-col">Команда</th>
${ENTRIES_COLS.map(([label, , title]) => `<th class="${colClass(label)}" title="${title}">${label}</th>`).join('')}
</tr></thead><tbody>`;

  for (const t of rows) {
    html += `<tr class="${t.rank <= 3 ? 'rank-' + t.rank : ''}">
  <td><span class="pos-badge">${t.rank}</span></td>
  <td class="driver-cell">${teamLink(t.team)}${coalMark(t.team)}</td>
  ${ENTRIES_COLS.map(([label, fn]) => `<td class="${colClass(label)}"${label === 'METRIC SCORE' && !isRanked(t) ? ` title="ENTRIES % ниже ${METRIC_MIN_ENTRIES} — команда вне ранжирования"` : ''}>${fn(t)}</td>`).join('')}
</tr>`;
  }
  document.getElementById('table-entries').innerHTML = html + '</tbody></table></div>'
    + `<div class="pagination"><span class="page-info">${rows.length} команд</span></div>`;
}

function setEntriesUpTo(val) {
  const rounds = entriesRounds();
  const n = parseFloat(val);
  state.entriesUpTo = n === rounds[rounds.length - 1] ? null : n;
  renderEntries();
}

function filterEntries(val) {
  state.entriesFilter = val;
  renderEntries();
}

// Все команды целиком, без поиска на экране
function exportEntriesXLSX() {
  const rounds = entriesRounds();
  const at = state.entriesUpTo ?? rounds[rounds.length - 1];
  downloadTableXLSX(entriesRows(at), [
    ['#', t => t.rank],
    ['Команда', t => t.team],
    ...ENTRIES_COLS.map(([label, fn]) => [label, fn]),
  ], 'Метрика', `${exportSeriesLabel()} метрика после ${fmtRoundNum(at)} этапа.xlsx`);
}
