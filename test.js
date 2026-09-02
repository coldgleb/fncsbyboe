/* Самопроверка: node test.js
   DQ приходит с листа как строка без Pos. — проверяем, что она встаёт по очкам,
   не пропадает из сводной и не перебивает реальное место.
   Штрафы с листа Deductions — что они снимаются с командного зачёта и меняют места. */

const assert = require('assert');
const fs = require('fs');
const DR_KEYS = ['DR1', 'DR2', 'DR3', 'DR4'];

// ── функции берём прямо из исходников, чтобы тест не разъезжался с кодом ──
const cut = (file, from, to) => {
  const src = fs.readFileSync(__dirname + '/js/' + file, 'utf8');
  return src.slice(src.indexOf(from), src.indexOf(to));
};
const orderField = new Function('DR_KEYS', cut('rounds.js', 'const orderField', 'const ofRound') + '; return orderField;')(DR_KEYS);

const posMap = new Function(cut('drivers.js', 'const posMap', '  const map = ') + '; return posMap;')();

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
  const teamStandings = (state, rows) => new Function('state',
    fs.readFileSync(__dirname + '/js/standings.js', 'utf8') + '; return computeTeamStandings;')(state)(rows);
  const rows = [                                   // P1 → 55 очк., P2 → 35 очк.
    { Round: 1, 'Pos.': 1, Driver: 'A', Team: 'Alpha' },
    { Round: 1, 'Pos.': 2, Driver: 'B', Team: 'Beta' },
  ];

  const clean = teamStandings({}, rows);           // state.deductions ещё не загружен — не падаем
  assert.deepStrictEqual(clean.map(t => [t.team, t.total, t.rank, t.penalty]),
    [['Alpha', 55, 1, 0], ['Beta', 35, 2, 0]], 'без штрафов');

  const fined = teamStandings({ deductions: { Alpha: { pts: 100, reason: 'За дело' } } }, rows);
  assert.deepStrictEqual(fined.map(t => [t.team, t.total, t.rank, t.penalty, t.penaltyReason]),
    [['Beta', 35, 1, 0, ''], ['Alpha', -45, 2, 100, 'За дело']], 'штраф снят и место потеряно');
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
  const { computeChaseStandings } = new Function('state',
    fs.readFileSync(__dirname + '/js/standings.js', 'utf8') + '; return { computeChaseStandings };')({
      quals: { rounds: Array.from({ length: 26 }, (_, i) => i + 1) },
      // D5 пропустил больше 5 квалификаций — вне Чейза, несмотря на очки в топ-5 по гонкам
      qualsParticipation: Object.fromEntries(
        Array.from({ length: 18 }, (_, i) => `D${i + 1}`)
          .map(d => [d, new Set(Array.from({ length: d === 'D5' ? 15 : 26 }, (_, i) => i + 1))])),
    });

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
}

console.log('ok');
