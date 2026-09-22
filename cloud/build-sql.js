/* Сборка cloud/data.sql из Google Sheets: node cloud/build-sql.js [год]
   Схема — cloud/schema.sql. Повторный запуск даёт полную замену данных. */

const fs = require('fs');
const path = require('path');

const SHEET_ID = '1677JnB2uVlF0AQcS3x4m45ewpKyzJkRBmwCD7EfJBBg';   // как SHEETS_BY_YEAR в js/core.js
const SEASON = Number(process.argv[2]) || 2026;
const OUT = path.join(__dirname, 'data.sql');

// Числовые поля листов — те же, что нормализует фронт (NUM_KEYS в js/core.js).
// «#» сюда не входит: номер машины со значащим нулём («06») числом становиться не должен.
const NUM_KEYS = new Set(['Round', 'Pos.', 'QL', 'DR1', 'DR2', 'DR3', 'DR4', 'DUE', 'CAU', 'RET', 'MN', 'Points']);

function toNum(v) {
  if (typeof v !== 'string') return v;
  const s = v.replace(/[\s ]/g, '').replace(',', '.');
  if (!s || s === '—' || s === '–' || s === '-') return null;
  const n = Number(s);
  return isFinite(n) ? n : v;
}

/* Лист приезжает тем же gviz-ответом, что и на фронте; boolean-колонка (служебная
   проверка TRUE/FALSE — в разных листах она называется P, M, Q, N) отбрасывается. */
async function fetchSheet(name) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`
    + `?tqx=responseHandler:x&sheet=${encodeURIComponent(name)}`;
  const txt = await (await fetch(url)).text();
  const json = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  const cols = json.table.cols.map(c => ({ key: c.label || c.id, type: c.type }));
  return json.table.rows.map(row => {
    const out = {};
    cols.forEach((c, i) => {
      if (c.type === 'boolean') return;
      const v = row.c[i] ? row.c[i].v : null;
      out[c.key] = NUM_KEYS.has(c.key) ? toNum(v) : v;
    });
    return out;
  });
}

// ── справочники: имя → id, порядок появления сохраняется ──
const makeDict = () => {
  const map = new Map();
  return {
    id(key) {
      if (key == null || key === '') return null;
      if (!map.has(key)) map.set(key, map.size + 1);
      return map.get(key);
    },
    get: key => map.get(key) ?? null,
    entries: () => [...map.entries()],
    get size() { return map.size; },
  };
};

const MFRS = ['Ford', 'Toyota', 'Chevrolet'];     // «-», «Academy» и пустые → NULL
const baseName = d => String(d).replace(/\s*\(i\)/g, '').trim();
const isGuestName = d => /\(i\)/.test(String(d));
const splitRound = r => (r % 1 === 0
  ? { round: r, duel: null }
  : { round: Math.trunc(r), duel: Math.round((r % 1) * 10) });

const q = v => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

// Многострочные INSERT: по 200 наборов значений на оператор
function insertStatements(table, columns, rows, chunk = 200) {
  const out = [];
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk)
      .map(r => `(${columns.map(c => q(r[c])).join(',')})`)
      .join(',\n  ');
    out.push(`INSERT INTO ${table} (${columns.join(', ')}) VALUES\n  ${part};`);
  }
  return out;
}

(async () => {
  const sheets = {
    openRaces: `${SEASON} Open Races`,
    openQuals: `${SEASON} Open Quals`,
    starRaces: `${SEASON} Star Races`,
    starQuals: `${SEASON} Star Quals`,
    calendar: `${SEASON} Calendar`,
    entries: `${SEASON} Open Entries`,
    deductions: `${SEASON} Deductions`,
    changes: `${SEASON} Changes`,
    coalitions: `${SEASON} Open Coalition Teams`,
    ogSquad: `${SEASON} OG Squad`,
  };

  const data = {};
  for (const [key, name] of Object.entries(sheets)) {
    data[key] = await fetchSheet(name).catch(err => {
      console.warn(`! лист «${name}» не прочитан: ${err.message}`);
      return [];
    });
    console.log(`${name}: ${data[key].length} строк`);
  }

  const participants = makeDict();
  const teams = makeDict();
  const cars = makeDict();                       // ключ — `${division}|${number}`
  const mfrId = name => (MFRS.includes(name) ? MFRS.indexOf(name) + 1 : null);

  // ── results ──
  const results = [];
  const protocols = [
    ['open', 'race', data.openRaces], ['open', 'qual', data.openQuals],
    ['star', 'race', data.starRaces], ['star', 'qual', data.starQuals],
  ];
  for (const [division, session, rows] of protocols) {
    for (const r of rows) {
      if (!r['Driver']) continue;               // хвост листа — заготовленные пустые строки
      const { round, duel } = splitRound(r['Round']);
      results.push({
        season: SEASON, division, session, round, duel,
        pos: r['Pos.'],
        participant_id: participants.id(baseName(r['Driver'])),
        is_guest: isGuestName(r['Driver']) ? 1 : 0,
        team_id: teams.id(r['Team']),
        car_id: r['#'] && r['#'] !== '-' ? cars.id(`${division}|${r['#']}`) : null,
        manufacturer_id: mfrId(r['M.']),
        ql: r['QL'], dr1: r['DR1'], dr2: r['DR2'], dr3: r['DR3'], dr4: r['DR4'],
        cau: r['CAU'] ?? null, ret: r['RET'] ?? null, mn: r['MN'] ?? null,
        due: r['DUE'] ?? null,
        points: r['Points'],
      });
    }
  }

  // ── rounds: календарь, дуэли отдельными записями ──
  const rounds = data.calendar.filter(r => r['#'] != null).map(r => {
    const { round, duel } = splitRound(r['#']);
    return { season: SEASON, round, duel, abbr: r['Abb.'], name: r['Name'] };
  });

  /* ── entries: лист без шапки. Первая строка — номера этапов по столбцам,
     вторая — подписи «Team»/«Car», дальше машины. Единица в клетке = заявка. */
  const entries = [];
  {
    const [head, , ...body] = data.entries;
    const roundByCol = Object.entries(head || {})
      .filter(([col, v]) => col !== 'A' && col !== 'B' && typeof v === 'number');
    for (const row of body) {
      const team = row['A'], number = row['B'];
      if (!team || !number) continue;
      const car_id = cars.id(`open|${number}`);
      const team_id = teams.id(team);
      for (const [col, round] of roundByCol) {
        if (row[col] == null) continue;
        entries.push({ season: SEASON, car_id, team_id, round });
      }
    }
  }

  // ── deductions ──
  const deductions = data.deductions
    .filter(r => r['Team'] && r['Points'] != null)
    .map(r => ({
      season: SEASON, team_id: teams.id(r['Team']),
      points: r['Points'], reason: r['Reason'] || null, round: r['Round'] ?? null,
    }));

  // ── division_changes: лист без шапки, первая строка данных — сами заголовки ──
  const changes = data.changes
    .filter(r => r['A'] && r['B'] && r['C'] && r['A'] !== 'Driver')
    .map(r => ({
      season: SEASON, participant_id: participants.id(baseName(r['A'])),
      from_division: String(r['B']).toLowerCase(), to_division: String(r['C']).toLowerCase(),
    }));

  // ── флаги в справочниках ──
  // Листы без шапки: gviz отдаёт её первой строкой данных («Team», «Driver») — отбрасываем
  const coalitionNames = new Set(data.coalitions.map(r => Object.values(r)[0])
    .filter(n => n && n !== 'Team'));
  const ogNames = new Set(data.ogSquad.map(r => Object.values(r)[0])
    .filter(n => n && n !== 'Driver').map(baseName));
  for (const n of coalitionNames) teams.id(n);    // коалиция могла не встретиться в протоколах
  for (const n of ogNames) participants.id(n);

  // ── SQL ──
  const sql = ['-- Сгенерировано cloud/build-sql.js, не редактировать руками',
    `-- Сезон ${SEASON}, ${new Date().toISOString()}`, '',
    'DELETE FROM division_changes;', 'DELETE FROM deductions;', 'DELETE FROM entries;',
    'DELETE FROM results;', 'DELETE FROM rounds;', 'DELETE FROM manufacturers;',
    'DELETE FROM cars;', 'DELETE FROM teams;', 'DELETE FROM participants;',
    "DELETE FROM sqlite_sequence WHERE name IN ('participants','teams','cars','manufacturers','results','deductions');",
    ''];

  sql.push(...insertStatements('participants', ['id', 'name', 'in_og_squad'],
    participants.entries().map(([name, id]) => ({ id, name, in_og_squad: ogNames.has(name) ? 1 : 0 }))));

  sql.push(...insertStatements('teams', ['id', 'name', 'is_coalition'],
    teams.entries().map(([name, id]) => ({ id, name, is_coalition: coalitionNames.has(name) ? 1 : 0 }))));

  sql.push(...insertStatements('cars', ['id', 'season', 'division', 'number'],
    cars.entries().map(([key, id]) => {
      const [division, number] = key.split('|');
      return { id, season: SEASON, division, number };
    })));

  sql.push(...insertStatements('manufacturers', ['id', 'name'],
    MFRS.map((name, i) => ({ id: i + 1, name }))));

  sql.push(...insertStatements('rounds', ['season', 'round', 'duel', 'abbr', 'name'], rounds));

  sql.push(...insertStatements('results',
    ['season', 'division', 'session', 'round', 'duel', 'pos', 'participant_id', 'is_guest',
      'team_id', 'car_id', 'manufacturer_id', 'ql', 'dr1', 'dr2', 'dr3', 'dr4',
      'cau', 'ret', 'mn', 'due', 'points'], results));

  sql.push(...insertStatements('entries', ['season', 'car_id', 'team_id', 'round'], entries));

  if (deductions.length) sql.push(...insertStatements('deductions',
    ['season', 'team_id', 'points', 'reason', 'round'], deductions));

  if (changes.length) sql.push(...insertStatements('division_changes',
    ['season', 'participant_id', 'from_division', 'to_division'], changes));

  sql.push('');
  fs.writeFileSync(OUT, sql.join('\n'), 'utf8');

  // ── сводка и подозрительные значения ──
  console.log('\n— собрано —');
  console.log('участников     ', participants.size, `(в OG Squad ${ogNames.size})`);
  console.log('команд         ', teams.size, `(коалиций ${coalitionNames.size})`);
  console.log('машин          ', cars.size);
  console.log('марок          ', MFRS.length);
  console.log('этапов         ', rounds.length);
  console.log('результатов    ', results.length, `(DQ без места ${results.filter(r => r.pos == null).length})`);
  console.log('заявок         ', entries.length);
  console.log('штрафов        ', deductions.length);
  console.log('смен дивизиона ', changes.length);
  console.log(`\n${OUT} — ${(fs.statSync(OUT).size / 1024).toFixed(0)} КБ`);

  const allRows = protocols.flatMap(([, , rows]) => rows).filter(r => r['Driver']);
  const oddMfr = [...new Set(allRows.map(r => r['M.']).filter(m => m && !MFRS.includes(m)))];
  const noCar = allRows.filter(r => !r['#'] || r['#'] === '-').length;
  const similar = teams.entries().map(([n]) => n)
    .filter(n => teams.entries().some(([m]) => m !== n && m.toLowerCase().replace(/\s+/g, '') === n.toLowerCase().replace(/\s+/g, '')));
  console.log('\n— на что посмотреть в таблице —');
  console.log('марки вне справочника →', oddMfr.length ? oddMfr.join(', ') : 'нет');
  console.log('строк без номера машины →', noCar);
  console.log('команды с разным написанием →', similar.length ? similar.join(' | ') : 'нет');
})();
