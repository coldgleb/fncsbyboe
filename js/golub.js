/* Зачёт им. Semen GOLUBOCHKIN */

const GOLUB = 'Semen GOLUBOCHKIN';
// по фамилии: в таблице имя пишут и как Semyon, и как Semen
const isGolub = d => d.includes('GOLUBOCHKIN');

function computeGolub(rows) {
  const byRound = {};
  for (const r of rows) {
    const rnd = r['Round'];
    if (rnd == null || r['Pos.'] == null || SPRINT_ROUNDS.has(rnd)) continue;
    (byRound[rnd] ||= []).push(r);
  }

  const rounds = [];
  const info = {};   // этап → позиция Голубочкина и число участников
  const map = {};
  for (const rnd of Object.keys(byRound).map(Number).sort((a, b) => a - b)) {
    const field = byRound[rnd];
    const gp = field.find(r => isGolub(r['Driver'] || ''))?.['Pos.'];
    if (gp == null) continue;  // этап без него в зачёт не идёт
    // финишировал последним — очков не набрал никто, колонка была бы пустой
    if (!field.some(x => x['Pos.'] > gp && x['Driver'] && !isGolub(x['Driver']) && !x['Driver'].includes('(i)'))) continue;
    rounds.push(rnd);
    info[rnd] = { gp, n: field.length };
    for (const r of field) {
      const d = r['Driver'], pos = r['Pos.'];
      if (!d || isGolub(d) || d.includes('(i)')) continue;
      const g = map[d] ||= { driver: d, team: teamOf(d), total: 0, cells: {} };
      // считаем участников, а не разницу позиций: в протоколе бывают пропуски в нумерации
      const pts = pos <= gp ? 0
        : field.reduce((n, x) => n + (x['Pos.'] > gp && x['Pos.'] <= pos ? 1 : 0), 0);
      g.cells[rnd] = { pts, gp, pos };
      g.total += pts;
    }
  }
  // ни разу не финишировал ниже — в зачёте не участвует
  const drivers = Object.values(map).filter(g => g.total > 0)
    .sort((a, b) => b.total - a.total)
    .map((g, i) => ({ ...g, rank: i + 1 }));
  return { rounds, info, drivers };
}

function golubClass(pts) {
  if (pts === 0) return 'pos-none';
  if (pts <= 5) return 'pos-gray';
  if (pts <= 10) return 'pos-bronze';
  if (pts <= 20) return 'pos-green';
  return 'pos-purple';
}

function renderGolub(type) {
  const { rounds, info, drivers } = state.golub[type];
  const list = drivers.filter(g => hit(state.golubFilter[type], g.driver, g.team));

  let html = `<table class="pivot-table" data-sort="auto"><thead><tr>
<th class="driver-col">Место · Пилот</th>
${rounds.map(r => `<th title="${roundFullName(r)} · ${GOLUB} P${info[r].gp} из ${info[r].n} участников">${roundLabel(r)}<span class="pivot-qpos">P${info[r].gp}/${info[r].n}</span></th>`).join('')}
<th>Итого</th>
  </tr></thead><tbody>`;

  for (const g of list) {
    html += `<tr class="${g.rank <= 3 ? 'rank-' + g.rank : ''}">
  <td class="driver-cell"><span class="pos-badge">${g.rank}</span> ${g.driver}${coalMark(g.team)}
  <div class="team-drivers">${g.team}</div></td>`;
    for (const r of rounds) {
      const c = g.cells[r];
      html += c == null
        ? '<td><span class="pos-cell pos-none">—</span></td>'
        : `<td title="${GOLUB} P${c.gp} · ${g.driver} P${c.pos}"><span class="pos-cell ${golubClass(c.pts)}">${c.pts}</span></td>`;
    }
    html += `<td class="total-cell">${g.total}</td></tr>`;
  }
  document.getElementById(`golub-${type}`).innerHTML = html + '</tbody></table>';
}

function setGolubView(type) {
  for (const t of ['races', 'quals']) {
    document.getElementById(`golub-card-${t}`).style.display = t === type ? '' : 'none';
    document.querySelector(`.rtog-btn[data-gv="${t}"]`).classList.toggle('rtog-active', t === type);
  }
}

function filterGolub(type, val) {
  state.golubFilter[type] = val;
  renderGolub(type);
}
