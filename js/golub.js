/* Зачёт им. Semen GOLUBOCHKIN */

const GOLUB = 'Semen GOLUBOCHKIN';

/* Сам зачёт (кто сколько участников «между ним и тобой», какие этапы идут в счёт)
   считается в базе, api.golub. Здесь — только показ. */

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

  for (const g of spoilerRows(`golub-${type}`, list, state.golubFilter[type])) {
    html += `<tr class="${g.rank <= 3 ? 'rank-' + g.rank : ''}">
  <td class="driver-cell"><span class="pos-badge">${g.rank}</span> ${driverLink(g.driver, type === 'quals' ? 'quals' : null)}${coalMark(g.team)}
  <div class="team-drivers">${teamLink(g.team)}</div></td>`;
    for (const r of rounds) {
      const c = g.cells[r];
      html += c == null
        ? '<td><span class="pos-cell pos-none">—</span></td>'
        : `<td title="${GOLUB} P${c.gp} · ${g.driver} P${c.pos}"><span class="pos-cell ${golubClass(c.pts)}">${c.pts}</span></td>`;
    }
    html += `<td class="total-cell">${g.total}</td></tr>`;
  }
  document.getElementById(`golub-${type}`).innerHTML = html + '</tbody></table>' + spoilerHtml(`golub-${type}`, list.length);
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
