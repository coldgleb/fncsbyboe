/* Заявки: сводная статистика команд на выбранный срез сезона.

   Лист Entries — матрица «команда × машина × этап» с единицей там, где машина заявлена;
   первая строка — номера этапов, вторая — подписи Team/Car (настоящей шапки у листа нет).
   Из него считается блок FULL TIME PARTICIPATION: там только фулл-тайм машины — заявленные
   подряд с момента заявления и до конца сезона. Остальные блоки считаются по всем прогнозам
   команды: и фулл-тайм, и парт-тайм машины, и гостевые пилоты — всё, что подано от её имени.

   Везде считаются только этапы регулярного сезона: дуэли и The Clash (этап 0) не в счёт. */

/* Сама метрика — статистика, ранги, ценз ENTRIES %, METRIC SCORE и контрольные точки
   (20, 26, 27 этапы) — считается в базе, api.metric. Здесь — только таблица и выгрузка. */
const METRIC_MIN_ENTRIES = 45;   // для подсказки «вне ранжирования»; сам ценз применяет база

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
  // метрику (со всеми контрольными точками) считает сервер, часть metric
  const { rounds, byRound } = state.metric || { rounds: [], byRound: {} };
  const at = state.entriesUpTo ?? rounds[rounds.length - 1];
  const rows = (byRound[at] || []).filter(t => hit(state.entriesFilter, t.team));

  let html = `<div class="table-upto">
  <label>По состоянию на этап:
    <select class="chart-select" onchange="setEntriesUpTo(this.value)">
      ${rounds.map(r => `<option value="${r}"${r === at ? ' selected' : ''}>${roundFullName(r)}</option>`).join('')}
    </select>
  </label>
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
  ${ENTRIES_COLS.map(([label, fn]) => `<td class="${colClass(label)}"${label === 'METRIC SCORE' && !t.ranked ? ` title="ENTRIES % ниже ${METRIC_MIN_ENTRIES} — команда вне ранжирования"` : ''}>${fn(t)}</td>`).join('')}
</tr>`;
  }
  document.getElementById('table-entries').innerHTML = html + '</tbody></table></div>'
    + `<div class="pagination"><span class="page-info">${rows.length} команд</span></div>`;
}

function setEntriesUpTo(val) {
  const rounds = (state.metric || { rounds: [] }).rounds;
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
  const { rounds, byRound } = state.metric || { rounds: [], byRound: {} };
  const at = state.entriesUpTo ?? rounds[rounds.length - 1];
  downloadTableXLSX(byRound[at] || [], [
    ['#', t => t.rank],
    ['Команда', t => t.team],
    ...ENTRIES_COLS.map(([label, fn]) => [label, fn]),
  ], 'Метрика', `${exportSeriesLabel()} метрика после ${fmtRoundNum(at)} этапа.xlsx`);
}
