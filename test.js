/* Самопроверка: node test.js
   DQ приходит с листа как строка без Pos. — проверяем, что она встаёт по очкам,
   не пропадает из сводной и не перебивает реальное место.
   Штрафы с листа Deductions — что они снимаются с командного зачёта и меняют места. */

const assert = require('assert');
const fs = require('fs');
const DR_KEYS = ['DR1', 'DR2', 'DR3', 'DR4'];

/* ── функции берём прямо из исходников, чтобы тест не разъезжался с кодом ──
   Правила зачётов теперь считает PostgreSQL (db/api.sql); их прежний JS-расчёт заморожен
   в db/reference/ как эталон — на нём и проверяются правила ниже, а db/verify.mjs сверяет
   с этим эталоном саму базу. Из js/ проверяется то, что осталось в браузере. */
const cutFrom = dir => (file, from, to) => {
  const src = fs.readFileSync(__dirname + dir + file, 'utf8');
  return src.slice(src.indexOf(from), src.indexOf(to));
};
const cut = cutFrom('/js/');               // то, что работает в браузере
const cutRef = cutFrom('/db/reference/');   // эталон правил
const orderField = new Function('DR_KEYS', cutRef('rounds.js', 'const orderField', 'const ofRound') + '; return orderField;')(DR_KEYS);

const posMap = new Function(cutRef('drivers.js', 'const posMap', '  const map = ') + '; return posMap;')();

const row = (pos, pts, dr = 10) => ({ 'Pos.': pos, Points: pts, DR1: dr, Driver: 'D' + pts, Round: 1 });

// Прогнозный этап: больше очков — выше. DQ со 120 очками должен встать между P2 (130) и P3 (110).
{
  const field = [row(1, 150), row(2, 130), row(3, 110), row(4, 90), row(null, 120)];
  const got = orderField(field).map(r => r.Points);
  assert.deepStrictEqual(got, [150, 130, 120, 110, 90], 'DQ по очкам между P2 и P3');
}

/* После DQ в протоколе остаётся дыра: место дисквалифицированного никому не отдают.
   Привязываться надо к номерам мест, а не к счёту обойдённых, иначе DQ уезжает на дыру вверх. */
{
  const field = [row(2, 194), row(3, 190), row(4, 187), row(null, 190)];  // P1 вакантно
  assert.deepStrictEqual(orderField(field).map(r => r['Pos.']),
    [2, 3, null, 4], 'DQ не перепрыгивает через дыру в местах');
}

// Квала по метрике (DR пустые): меньше очков — лучше.
{
  const m = (pos, pts) => ({ 'Pos.': pos, Points: pts, Driver: 'M' + pts, Round: 1 });
  const field = [m(1, 40), m(2, 55), m(3, 70), m(null, 60)];
  assert.deepStrictEqual(orderField(field).map(r => r.Points), [40, 55, 60, 70], 'метрика: меньше — лучше');
}

// DQ без очков вовсе — в конец, но перед никем не оказывается выше зачётных
{
  const field = [row(1, 100), row(2, 80), row(null, null)];
  assert.deepStrictEqual(orderField(field).map(r => r['Pos.']), [1, 2, null], 'DQ без очков — последним');
}

// Сводная: этап с DQ есть в карте со значением null, пропущенного этапа в карте нет
{
  const m = posMap([
    { Driver: 'A', Round: 5, 'Pos.': null },
    { Driver: 'A', Round: 6, 'Pos.': 12 },
  ]);
  assert.ok(5 in m.A && m.A[5] === null, 'DQ: ключ есть, значение null');
  assert.ok(!(7 in m.A), 'пропущенный этап — ключа нет');
  assert.strictEqual(m.A[6], 12);
}

// Дубли строк на этап: реальное место перебивает DQ в любом порядке, лучшее из двух мест побеждает
{
  assert.strictEqual(posMap([
    { Driver: 'A', Round: 5, 'Pos.': null },
    { Driver: 'A', Round: 5, 'Pos.': 9 },
  ]).A[5], 9, 'место перебивает DQ');
  assert.strictEqual(posMap([
    { Driver: 'A', Round: 5, 'Pos.': 9 },
    { Driver: 'A', Round: 5, 'Pos.': null },
  ]).A[5], 9, 'DQ не затирает место');
  assert.strictEqual(posMap([
    { Driver: 'A', Round: 5, 'Pos.': 9 },
    { Driver: 'A', Round: 5, 'Pos.': 4 },
  ]).A[5], 4, 'из двух мест — лучшее');
}

// Сортировка таблиц: DQ уходит вниз наравне с пустыми ячейками
{
  const src = fs.readFileSync(__dirname + '/js/core.js', 'utf8');
  const body = src.slice(src.indexOf('function cellValue'), src.indexOf('/* Места не ездят'));
  const cellValue = new Function('return ' + body.trim())();
  const td = (text, mark) => ({ textContent: text, dataset: {}, querySelector: () => mark ? { textContent: mark } : null });
  assert.strictEqual(cellValue(td('DQ')), null, 'DQ сортируется как пусто');
  assert.strictEqual(cellValue(td('—')), null);
  assert.strictEqual(cellValue(td('12')), 12);
  // очки со штрафом: сортируем по 494, а не по строке «−100 494»
  assert.strictEqual(cellValue(td('−100 494', '−100')), 494, 'метка штрафа не мешает сортировке');
}

// Штрафы: снимаются с командного зачёта и переставляют места
{
  // isGuestDriver живёт в core.js — сюда подставляем заглушку, гостей в этом наборе нет
  const teamStandings = (state, rows) => new Function('state', 'isGuestDriver',
    fs.readFileSync(__dirname + '/db/reference/standings.js', 'utf8') + '; return computeTeamStandings;')(state, () => false)(rows);
  const rows = [                                   // P1 → 55 очк., P2 → 35 очк.
    { Round: 1, 'Pos.': 1, Driver: 'A', Team: 'Alpha' },
    { Round: 1, 'Pos.': 2, Driver: 'B', Team: 'Beta' },
  ];

  const clean = teamStandings({}, rows);           // state.deductions ещё не загружен — не падаем
  assert.deepStrictEqual(clean.map(t => [t.team, t.total, t.rank, t.penalty]),
    [['Alpha', 55, 1, 0], ['Beta', 35, 2, 0]], 'без штрафов');

  const fined = teamStandings({ deductions: { Alpha: { pts: 100, reason: 'За дело' } } }, rows);
  assert.deepStrictEqual(fined.map(t => [t.team, t.total, t.rank, t.penalty, t.penaltyReason]),
    [['Beta', 35, 1, 0, ''], ['Alpha', -45, 2, 100, 'За дело']], 'штраф без этапа — сезонный');

  // Штраф со 2 этапа: на срезе после 1 этапа его ещё нет, после 2 — уже есть
  const late = { deductions: { Alpha: { pts: 100, reason: 'За дело', round: 2 } } };
  const rows2 = [...rows, { Round: 2, 'Pos.': 1, Driver: 'A', Team: 'Alpha' }];
  assert.deepStrictEqual(teamStandings(late, rows).map(t => [t.team, t.total, t.penalty]),
    [['Alpha', 55, 0], ['Beta', 35, 0]], 'до своего этапа штраф не применяется');
  assert.deepStrictEqual(teamStandings(late, rows2).map(t => [t.team, t.total, t.penalty]),
    [['Beta', 35, 0], ['Alpha', 10, 100]], 'со своего этапа штраф снят');
}

// Накопительный итог: штраф входит в него со своего этапа, а не с начала сезона
{
  const penaltyBy = new Function(cutRef('core.js', 'const penaltyBy', '/* Производителя') + '; return penaltyBy;')();
  const t = { penalty: 100, penaltyRound: 3 };
  assert.deepStrictEqual([1, 2, 3, 4].map(r => penaltyBy(t, r)), [0, 0, 100, 100], 'штраф с 3 этапа');
  assert.strictEqual(penaltyBy({ penalty: 100, penaltyRound: null }, 1), 100, 'без этапа — сезонный');
  assert.strictEqual(penaltyBy({ penalty: 0, penaltyRound: 3 }, 5), 0, 'без штрафа вычитать нечего');
}

// Метка штрафа: идёт перед очками, причина — в подсказке, кавычки из листа не рвут title
{
  const penMark = new Function(cut('core.js', 'function penMark', 'function mfrBadge') + '; return penMark;')();
  assert.strictEqual(penMark({ penalty: 0 }), '', 'без штрафа метки нет');
  const m = penMark({ penalty: 100, penaltyReason: 'Нарушение «регламента»' });
  assert.ok(m.endsWith('>−100</span> '), 'метка отделена от очков и стоит перед ними');
  assert.ok(m.includes('title="Нарушение «регламента»"'), 'подсказка — только причина с листа');
  assert.ok(!penMark({ penalty: 50 }).includes('title'), 'пустой Reason — метка без подсказки');
  assert.ok(!penMark({ penalty: 50, penaltyReason: 'a "b" c' }).includes('"b"'), 'кавычки экранированы');
}

// Чейз: топ-16 сбрасываются на стартовую сетку после 26 этапа, остальные копят очки как обычно
{
  const { computeChaseStandings } = new Function('state', 'isGuestDriver',
    fs.readFileSync(__dirname + '/db/reference/standings.js', 'utf8') + '; return { computeChaseStandings };')({
      quals: { rounds: Array.from({ length: 26 }, (_, i) => i + 1) },
      // D5 пропустил больше 5 квалификаций — вне Чейза, несмотря на очки в топ-5 по гонкам
      qualsParticipation: Object.fromEntries(
        Array.from({ length: 18 }, (_, i) => `D${i + 1}`)
          .map(d => [d, new Set(Array.from({ length: d === 'D5' ? 15 : 26 }, (_, i) => i + 1))])),
    }, () => false);

  // Round 1: места 1..18 задают порядок по очкам регулярного сезона
  const regRows = Array.from({ length: 18 }, (_, i) => ({ Round: 1, 'Pos.': i + 1, Driver: `D${i + 1}` }));

  // Срез ровно на 26 этапе: топ-16 (без D5) уже получают стартовую сетку
  const at26 = computeChaseStandings(regRows);
  const byDriver = Object.fromEntries(at26.map(s => [s.driver, s]));
  assert.strictEqual(byDriver.D1.total, 2100, 'лидер регулярного сезона — сид 1');
  assert.strictEqual(byDriver.D5.total, 32, 'D5 не набрал ценз квалификаций — вне Чейза, очки свои');
  assert.strictEqual(byDriver.D17.total, 2000, 'слот D5 сдвинул границу — 17-й по очкам стал 16-м сидом');
  assert.strictEqual(byDriver.D18.total, 19, 'вне топ-16 — очки как в обычном сезоне, без сброса');

  // Этап 27: у Чейза очки копятся поверх сетки, у остальных — как раньше, без сброса
  const withR27 = computeChaseStandings([
    ...regRows,
    { Round: 27, 'Pos.': 5, Driver: 'D1' },   // Чейз: 2100 + 32
    { Round: 27, 'Pos.': 1, Driver: 'D18' },  // вне Чейза: 19 + 55
  ]);
  const byDriver27 = Object.fromEntries(withR27.map(s => [s.driver, s]));
  assert.strictEqual(byDriver27.D1.total, 2132, 'Чейз: сид + очки за 27 этап');
  assert.strictEqual(byDriver27.D18.total, 74, 'вне Чейза: сумма очков за все этапы, без сброса');
  assert.strictEqual(byDriver27.D1.wins, 1, 'Чейз: победа в регулярном сезоне остаётся в статистике');
  assert.strictEqual(byDriver27.D1.finishes, 2, 'Чейз: участие до Чейза учитывается');
  assert.strictEqual(byDriver27.D1.chase.wins, 0, 'тай-брейк Чейза — только по его этапам');
}

// Чейз владельцев: топ-16 машин сбрасываются на стартовую сетку после 26 этапа
{
  const { computeChaseOwnerStandings } = new Function('state', 'isGuestDriver',
    fs.readFileSync(__dirname + '/db/reference/standings.js', 'utf8') + '; return { computeChaseOwnerStandings };')({
      quals: { rounds: Array.from({ length: 26 }, (_, i) => i + 1) },
      qualsParticipation: {},
    }, () => false);

  const regRows = Array.from({ length: 18 }, (_, i) => ({ Round: 1, 'Pos.': i + 1, '#': String(i + 1) }));

  const at26 = computeChaseOwnerStandings(regRows);
  const byCar = Object.fromEntries(at26.map(o => [o.car, o]));
  assert.strictEqual(byCar['1'].total, 2100, 'лидер по машинам — сид 1');
  assert.strictEqual(byCar['17'].total, 20, '17-я машина вне топ-16 — очки без сброса (55-35=20)');

  const withR27 = computeChaseOwnerStandings([
    ...regRows,
    { Round: 27, 'Pos.': 5, '#': '1' },
    { Round: 27, 'Pos.': 1, '#': '17' },
  ]);
  const byCar27 = Object.fromEntries(withR27.map(o => [o.car, o]));
  assert.strictEqual(byCar27['1'].total, 2132, 'Чейз: сид + очки за 27 этап');
  assert.strictEqual(byCar27['17'].total, 75, 'вне Чейза: сумма очков за все этапы, без сброса (20 + 55)');
}

// Метрика на следующий этап (п. 8.8): 50% гонка, 25% чемпионат, 25% машина у владельцев
{
  const { computeNextMetric, metricChampRanks } = new Function('state', 'isGuestDriver',
    fs.readFileSync(__dirname + '/db/reference/standings.js', 'utf8') + '; return { computeNextMetric, metricChampRanks };')(
    {}, d => d === 'G');

  const m = computeNextMetric([
    { driver: 'A', place: 1, champRank: 3, ownerRank: 5 },   // 0.5 + 0.75 + 1.25 = 2.5
    { driver: 'B', place: 2, champRank: 1, ownerRank: 5 },   // 1 + 0.25 + 1.25 = 2.5, но выше в чемпионате
    { driver: 'C', place: 41, champRank: 2, ownerRank: 1 },
  ]);
  assert.strictEqual(m.find(x => x.driver === 'A').metric, 2.5, 'формула 50/25/25');
  assert.deepStrictEqual(m.map(x => x.driver), ['B', 'A', 'C'], 'равная метрика — выше тот, кто выше в чемпионате (п. 8.8.2)');

  const ranks = metricChampRanks(
    [{ driver: 'A', rank: 1 }, { driver: 'B', rank: 2 }, { driver: 'G', rank: null }],
    [
      { Driver: 'X', Round: 2, 'Pos.': 45 }, { Driver: 'X', Round: 3, 'Pos.': 50 },
      { Driver: 'Y', Round: 2, 'Pos.': 42 }, { Driver: 'Y', Round: 3, 'Pos.': 48 },
      { Driver: 'Z', Round: 3, 'Pos.': 41 },                 // другой набор этапов
      { Driver: 'X', Round: 1.1, 'Pos.': 1 },                // дуэль не в счёт
    ]);
  assert.strictEqual(ranks.A, 1, 'зачётный — своё место');
  assert.strictEqual(ranks.G, 3, 'гость — последнее + 1');
  assert.strictEqual(ranks.Y, 3, 'без стартов, те же этапы, лучшая квала — выше (п. 8.8.3)');
  assert.strictEqual(ranks.X, 4, 'без стартов, те же этапы, квала хуже');
  assert.strictEqual(ranks.Z, 3, 'без стартов с другим набором этапов — делит место');
}

// Заявки: фулл-тайм машины, статистика по всем прогнозам команды и ранги с общими местами
{
  const src = fs.readFileSync(__dirname + '/db/reference/entries.js', 'utf8');
  const load = state => new Function('state', 'SPRINT_ROUNDS',
    src + '; return { computeEntries, factByTeamRound, planByTeam, teamStats, rankBy, metricScore, isRanked };')(state, new Set([1.1, 1.2]));

  // строка 0 — номера этапов, строка 1 — подписи Team/Car, дальше по строке на машину
  const sheet = [
    { A: null, B: null, C: 1, D: 2, E: 3, F: 4 },
    { A: 'Team', B: 'Car', C: null, D: null, E: null, F: null },
    { A: 'Alpha', B: '01', C: 1, D: 1, E: 1, F: 1 },       // фулл-тайм с 1 этапа
    { A: 'Alpha', B: '02', C: null, D: 1, E: 1, F: 1 },    // фулл-тайм со 2 этапа
    { A: 'Alpha', B: '03', C: 1, D: null, E: 1, F: null }, // парт-тайм: дыра и не до конца
    { A: 'Beta', B: '11', C: 1, D: null, E: null, F: null },// разовая заявка — тоже парт-тайм
  ];
  const entries = load({}).computeEntries(sheet);
  assert.deepStrictEqual(Object.keys(entries), ['Alpha'], 'команда без фулл-тайм машин выпадает');
  assert.deepStrictEqual(Object.keys(entries.Alpha), ['01', '02'], 'парт-тайм машины не в счёт');

  // этап 2 — по метрике; этап 0 (Clash) и дуэль 1.1 не в счёт нигде
  const state = {
    entries,
    metricQuals: new Set([2]),
    quals: {
      rows: [
        { Team: 'Alpha', '#': '01', Round: 0, 'Pos.': 1 },
        { Team: 'Alpha', '#': '01', Round: 1.1, 'Pos.': 1 },
        { Team: 'Alpha', '#': '01', Round: 1, 'Pos.': 4 },
        { Team: 'Alpha', '#': '01', Round: 2, 'Pos.': 1 },   // метрика: в средние и топ-10 не идёт
        { Team: 'Alpha', '#': '02', Round: 2, 'Pos.': 30 },
        { Team: 'Alpha', '#': '03', Round: 1, 'Pos.': 20 },  // парт-тайм машина: в факт не идёт
        { Team: 'Alpha', '#': '01', Round: 3, 'Pos.': null },// DQ: прогноз есть, позиции нет
        { Team: 'Beta', '#': '11', Round: 1, 'Pos.': 12 },
      ],
    },
    races: {
      rows: [
        { Team: 'Alpha', '#': '01', Round: 0, 'Pos.': 1 },
        { Team: 'Alpha', '#': '01', Round: 1, 'Pos.': 1 },
        { Team: 'Alpha', '#': '03', Round: 1, 'Pos.': 9 },
        { Team: 'Alpha', '#': '01', Round: 2, 'Pos.': null },// DQ: старт есть, позиции нет
      ],
    },
  };
  const { factByTeamRound, planByTeam, teamStats, rankBy } = load(state);

  assert.deepStrictEqual(factByTeamRound(), { Alpha: { 1: 1, 2: 2, 3: 1 } }, 'факт — только фулл-тайм машины');
  // на 2 этап: план 3 (машина 01 — 2 этапа, машина 02 — 1)
  assert.strictEqual(planByTeam('Alpha', [1, 2]), 3, 'план считается с момента заявления');
  assert.strictEqual(planByTeam('Alpha', [1, 2, 3]), 5, 'план не зависит от пропусков');

  // квалифицировался гостем без машины, а стартовал за команду — прогноз считается ей
  state.quals.rows.push({ Team: 'Guest entry', '#': '-', Round: 3, 'Pos.': 8 });
  state.races.rows.push({ Team: 'Alpha', '#': '03', Round: 3, 'Pos.': 8, Driver: 'G' });
  state.quals.rows[state.quals.rows.length - 1].Driver = 'G';
  const withGuest = load(state).teamStats(3)['Alpha'];
  assert.strictEqual(withGuest.entriesTotal, 6, 'гостевой прогноз ушёл команде, за которую он стартовал');
  assert.strictEqual(withGuest.top10Q, 2, 'и попал в её топ-10 квалификации');
  state.quals.rows.pop();
  state.races.rows.pop();

  const a = teamStats(3)['Alpha'];
  assert.strictEqual(a.entriesTotal, 5, 'все прогнозы команды, включая парт-тайм и DQ; дуэль и Clash — нет');
  assert.strictEqual(a.realQuals, 3, 'этап по метрике — не соревновательная квалификация');
  assert.strictEqual(a.qPosSum / a.qPosN, 12, 'AVG Q: (4 + 20) / 2, DQ без позиции не в счёт');
  assert.strictEqual(a.top10Q, 1, 'топ-10 квалы — только по соревновательным этапам');
  assert.strictEqual(a.starts, 3, 'старты: строки гонок без Clash, DQ считается стартом');
  assert.strictEqual(a.rPosSum / a.rPosN, 5, 'AVG R: (1 + 9) / 2, DQ не в счёт');
  assert.strictEqual(a.top10R, 2, 'топ-10 гонки');
  assert.strictEqual(a.wins, 1, 'победа только из зачётного этапа');
  assert.strictEqual(teamStats(1)['Alpha'].entriesTotal, 2, 'срез по этапу режет и статистику');

  // Ранги: общее место — наименьший ранг на всю группу, следующий сдвигается на её размер
  const rows = [{ w: 3 }, { w: 2 }, { w: 2 }, { w: 2 }, { w: 1 }, { w: null }];
  rankBy(rows, 'w');
  assert.deepStrictEqual(rows.map(r => r.wRank), [1, 2, 2, 2, 5, null], 'три вторых — ранг 2, дальше 5');
  const byAvg = [{ p: 10.5 }, { p: 9 }, { p: 9 }];
  rankBy(byAvg, 'p', 'min');
  assert.deepStrictEqual(byAvg.map(r => r.pRank), [3, 1, 1], 'меньше — лучше');

  // METRIC SCORE — пример из регламента: база 7,75 при участии 94,2% даёт 8,200
  const { metricScore, isRanked } = load(state);

  // Ценз: ранжируются только команды с ENTRIES % не ниже 50
  assert.deepStrictEqual([44.9, 45, 100, null].map(pct => isRanked({ pct })),
    [false, true, true, false], 'ценз участия — 45% ровно проходит');
  // ранги считаются по прошедшим ценз, отсеянная команда чужие ранги не двигает
  const pool = [{ pct: 100, w: 1 }, { pct: 10, w: 5 }, { pct: 60, w: 3 }];
  rankBy(pool.filter(isRanked), 'w');
  assert.deepStrictEqual(pool.map(t => t.wRank), [2, undefined, 1], 'вне ценза — без ранга');
  const sample = {
    avgQRank: 5, top10QPctRank: 8, startsPctRank: 4, avgRRank: 9,
    top10RPctRank: 12, winsRank: 6, teamPtsRank: 7, pct: 94.2,
  };
  assert.strictEqual(metricScore(sample).toFixed(3), '8.200', 'метрика по примеру из регламента');
  // 100% участия оставляет базовую метрику как есть
  assert.strictEqual(metricScore({ ...sample, pct: 100 }).toFixed(3), '7.750', 'без пропусков — базовая метрика');
  assert.strictEqual(metricScore({ ...sample, winsRank: null }), null, 'без одного ранга метрики нет');
  assert.strictEqual(metricScore({ ...sample, pct: null }), null, 'без плановых заявок метрики нет');
}

{
  // Чейз (сброс очков на сетку 2000+) — только после 26 этапа, даже если тумблер стоит на «Чейз»
  const state = { chaseView: { races: 'chase', quals: 'auto', owners: 'regular' } };
  const isChaseMode = new Function('state', 'CHASE_START',
    cut('drivers.js', 'const isChaseMode', '// Зачёт по состоянию') + '; return isChaseMode;')(state, 26);

  assert.strictEqual(isChaseMode('races', 10), false, 'на 10 этапе Чейза нет даже при явном выборе');
  assert.strictEqual(isChaseMode('races', 26), false, '26 этап — последний регулярный, Чейза ещё нет');
  assert.strictEqual(isChaseMode('races', 27), true, 'с 27 этапа выбор «Чейз» действует');
  assert.strictEqual(isChaseMode('quals', 27), true, 'auto с 27 этапа — Чейз');
  assert.strictEqual(isChaseMode('quals', 26), false, 'auto до 27 этапа — регулярный сезон');
  assert.strictEqual(isChaseMode('owners', 28), false, 'явный «Регулярный сезон» отключает Чейз и после 26');
}

{
  // Числа из листов: ячейка могла оказаться текстом, разделитель — точка или запятая
  const toNum = new Function(cut('core.js', 'function toNum', '/* ── Кэш листов') + '; return toNum;')();

  assert.strictEqual(toNum('12.5'), 12.5, 'точка как разделитель');
  assert.strictEqual(toNum('12,5'), 12.5, 'запятая как разделитель');
  assert.strictEqual(toNum('124'), 124, 'целое текстом');
  assert.strictEqual(toNum(' 40 '), 40, 'пробелы вокруг числа');
  assert.strictEqual(toNum('1 250'), 1250, 'разряды через пробел');
  assert.strictEqual(toNum('-3'), -3, 'минус сохраняется');
  assert.strictEqual(toNum(55), 55, 'число не трогаем');
  assert.strictEqual(toNum(null), null, 'пустая ячейка — null');
  assert.strictEqual(toNum(''), null, 'пустая строка — null');
  assert.strictEqual(toNum('—'), null, 'прочерк — null');
  assert.strictEqual(toNum('DQ'), 'DQ', 'не число — как есть');
  // '09' превратилось бы в 9, поэтому «#» (номер машины) не входит в NUM_KEYS
  assert.strictEqual(toNum('09'), 9, 'ведущий ноль теряется — «#» не нормализуем');
}

console.log('ok');
