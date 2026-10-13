/**
 * A local stand-in for a UTR event's Event Desk Players tab, for rehearsing group-draws:
 * division filter, player rows with checkboxes, "Add to new draw" with a Create draw form,
 * a DRAWS panel (with an existing automated "Group A" and five subgroups) and a draw page.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

export const GROUPS_EVENT_ID = 500001;
export const GROUPS_EVENT_NAME = 'Prosper Premier Racquet Club Verified Tournament';
/** As UTR may print it, with a typographic apostrophe. */
export const LADDER = 'Men’s Open Singles Ladder';
const DIVISIONS = [LADDER, 'Men’s Open Doubles Ladder', 'Co-ed Level-based Singles'];

export interface GroupsPlayer { id: number; name: string; division: string }
export interface GroupsDraw { id: string; name: string; drawType: string; format: string; players: number[] }
export interface GroupsState { players: GroupsPlayer[]; draws: GroupsDraw[]; writes: string[] }

const esc = (v: string) => v.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function initialState(): GroupsState {
  const config = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../groups.json'), 'utf8')) as { groups: { players: string[] }[] };
  const names = config.groups.flatMap(g => g.players);
  const players: GroupsPlayer[] = [];
  const add = (name: string, division: string) => players.push({ id: players.length, name, division });
  for (const name of names) add(name, LADDER);
  add('Extra Ladder Player', LADDER);
  add('Ravi Kumar', LADDER); add('Ravi Kumar', LADDER);
  // Same names in other divisions: only the division filter keeps them apart.
  add('Uma Vommi', DIVISIONS[1]!); add('Brian Chong', DIVISIONS[1]!); add('Pranav Vommi', DIVISIONS[2]!);
  const draws: GroupsDraw[] = [{ id: 'auto-a', name: 'Group A', drawType: 'Round Robin', format: 'Two Sets w/ Match Tiebreaker', players: [0, 1, 2, 3] }];
  for (let i = 1; i <= 5; i++) draws.push({ id: `auto-a${i}`, name: `Group A - ${i}`, drawType: 'Round Robin', format: 'Two Sets w/ Match Tiebreaker', players: [i] });
  return { players, draws, writes: [] };
}

function shell(state: GroupsState, body: string): string {
  return `<!doctype html><html><head><title>Event Desk | UTR</title><style>
.rail{position:fixed;left:0;top:0;width:50px}.ri{cursor:pointer;padding:8px 2px;font-size:11px}
#drawsPanel{position:fixed;left:55px;top:0;width:260px;background:#eee;padding:6px}.dl{cursor:pointer;padding:3px}
main{margin-left:330px}.prow{display:flex;gap:10px;padding:4px;border-bottom:1px solid #ddd}.prow>div{display:block}
.sel,.divsel,.drawsel{cursor:pointer;border:1px solid #333;padding:3px;display:inline-block}.btn{cursor:pointer;border:1px solid #000;padding:4px;display:inline-block}
#newPanel{position:fixed;right:0;top:0;width:360px;background:#fff;border:1px solid #333;padding:10px;z-index:9}
</style></head><body><header><a data-testid="user-menu" href="/profile/1">My profile</a></header>
<nav class="rail"><div class="ri" id="railPlayers">Players</div><div class="ri" id="railDraws">Draws</div></nav>
<aside id="drawsPanel" style="display:none"><div style="display:flex">DRAWS</div><input placeholder="Find a draw" id="findDraw" style="width:240px"><div id="drawList"></div></aside>
${body}
<script>
const STATE = ${JSON.stringify(state)};
const call = (method, url, body) => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); });
document.getElementById('railPlayers').onclick = () => { location.href = '/events/${GROUPS_EVENT_ID}/draws?v=playersTab'; };
document.getElementById('railDraws').onclick = () => { const p = document.getElementById('drawsPanel'); p.style.display = p.style.display === 'none' ? 'block' : 'none'; };
function renderDraws() {
  const q = document.getElementById('findDraw').value.trim().toLowerCase();
  document.getElementById('drawList').innerHTML = STATE.draws.filter(d => !q || d.name.toLowerCase().includes(q))
    .map(d => '<div class="dl" data-id="' + d.id + '">' + d.name.replace(/</g, '&lt;') + '</div>').join('');
  document.querySelectorAll('.dl').forEach(el => el.onclick = () => { location.href = '/events/${GROUPS_EVENT_ID}/draws?v=drawEditor&d=' + el.dataset.id; });
}
document.getElementById('findDraw').addEventListener('input', renderDraws);
renderDraws();
</script></body></html>`;
}

function playersTab(state: GroupsState): string {
  return shell(state, `<main>
<div><div class="divsel" role="button" aria-haspopup="listbox">All Divisions &#9662;</div> <div class="drawsel" role="button" aria-haspopup="listbox">All Draws &#9662;</div>
<input placeholder="Filter players" id="filterPlayers"></div>
<div id="bulk" style="display:none"><span id="selcount"></span> <div class="btn" id="addNew">ADD TO NEW DRAW</div></div>
<div class="phead"><input type="checkbox" id="selectAll"> <span>Name</span> <span>Singles</span> <span>Doubles</span> <span>Contact</span> <span>Reg.st</span> <span>Division</span> <span>Draw</span></div>
<div id="rows" style="max-height:420px;overflow-y:auto"></div>
</main>
<div id="newPanel" style="display:none"></div>
<script>
let division = 'All Divisions'; const selected = new Set();
function rows() {
  const q = document.getElementById('filterPlayers').value.trim().toLowerCase();
  const list = STATE.players.filter(p => (division === 'All Divisions' || p.division === division) && (!q || p.name.toLowerCase().includes(q)));
  document.getElementById('rows').innerHTML = list.map(p => '<div class="prow"><input type="checkbox" data-id="' + p.id + '"' + (selected.has(p.id) ? ' checked' : '') + '>' +
    '<div class="pn">' + p.name + '</div><div>' + (1 + p.id % 5) + '.' + (10 + p.id % 80) + '</div><div>UR</div><div>player' + p.id + '@example.com</div><div>Main</div>' +
    '<div class="dv">' + p.division + '</div><div class="dr">' + STATE.draws.filter(d => d.players.includes(p.id)).map(d => d.name).join('<br>') + '</div></div>').join('');
  document.querySelectorAll('#rows input[type=checkbox]').forEach(cb => cb.onchange = () => { const id = Number(cb.dataset.id); cb.checked ? selected.add(id) : selected.delete(id); bulk(); });
}
function bulk() { document.getElementById('bulk').style.display = selected.size ? 'block' : 'none'; document.getElementById('selcount').textContent = selected.size + ' selected'; }
document.getElementById('filterPlayers').addEventListener('input', rows);
document.querySelector('.divsel').onclick = () => {
  document.querySelectorAll('ul[role=listbox]').forEach(x => x.remove());
  const ul = document.createElement('ul'); ul.setAttribute('role', 'listbox');
  ['All Divisions', ...${JSON.stringify(DIVISIONS)}].forEach(d => { const li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = d;
    li.onclick = () => { division = d; document.querySelector('.divsel').innerHTML = d + ' &#9662;'; ul.remove(); selected.clear(); bulk(); rows(); }; ul.append(li); });
  document.querySelector('.divsel').after(ul);
};
function sel(label, opts) { return '<div class="f"><label>' + label + '</label><div class="sel" role="button" aria-haspopup="listbox" data-field="' + label + '" data-opts="' + opts + '">' + opts.split('|')[0] + '</div></div>'; }
document.getElementById('addNew').onclick = () => {
  const p = document.getElementById('newPanel');
  const chosen = STATE.players.filter(x => selected.has(x.id));
  p.innerHTML = '<h3>Create draw</h3><div class="f"><label>Draw name</label><input id="dn"></div>' + sel('Draw type', 'Round Robin|Ad-Hoc|Single Elimination') +
    sel('Format', 'Two Sets w/ Match Tiebreaker|Best of 3 Sets|Pro Set') + '<div>Players (' + chosen.length + ')</div><ul>' + chosen.map(x => '<li>' + x.name + '</li>').join('') + '</ul>' +
    '<div class="btn" id="cancelNew">CANCEL</div> <div class="btn" id="addDraw">ADD DRAW</div>';
  p.style.display = 'block';
  p.querySelectorAll('.sel').forEach(s => s.onclick = () => {
    p.querySelectorAll('ul[role=listbox]').forEach(x => x.remove());
    const ul = document.createElement('ul'); ul.setAttribute('role', 'listbox');
    s.dataset.opts.split('|').forEach(o => { const li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = o; li.onclick = () => { s.textContent = o; ul.remove(); }; ul.append(li); });
    s.after(ul);
  });
  document.getElementById('cancelNew').onclick = () => { p.style.display = 'none'; p.innerHTML = ''; };
  document.getElementById('addDraw').onclick = () => {
    const field = n => p.querySelector('.sel[data-field="' + n + '"]').textContent;
    call('POST', '/api/v1/group-draws', { name: document.getElementById('dn').value, drawType: field('Draw type'), format: field('Format'), players: [...selected] }).then(d => {
      STATE.draws.push(d); p.style.display = 'none'; p.innerHTML = ''; selected.clear(); bulk(); rows(); renderDraws();
    }).catch(e => alert(e.message));
  };
};
rows();
</script>`);
}

function drawPage(state: GroupsState, id: string | null): string {
  const draw = state.draws.find(d => d.id === id);
  return shell(state, `<main>${draw
    ? `<h2>${esc(draw.name)}</h2><div>${esc(draw.drawType)}, ${esc(draw.format)}</div><div>PLAYERS (${draw.players.length})</div><ul>${draw.players.map(p => `<li>${esc(state.players[p]!.name)}</li>`).join('')}</ul>`
    : '<div>Select a draw</div>'}</main>`);
}

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}

export async function startMockGroups(): Promise<{ origin: string; eventUrl: string; state: GroupsState; close(): Promise<void> }> {
  const state = initialState();
  let next = 1;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, payload: unknown, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); };
    try {
      if (req.method !== 'GET') state.writes.push(`${req.method} ${url.pathname}`);
      if (url.pathname === '/' || url.pathname.startsWith('/profile')) return send(200, '<!doctype html><title>UTR</title><a data-testid="user-menu" href="/profile/1">My profile</a><main>Home</main>', 'text/html; charset=utf-8');
      if (url.pathname === `/events/${GROUPS_EVENT_ID}`) {
        return send(200, `<!doctype html><title>${GROUPS_EVENT_NAME}</title><header><a data-testid="user-menu" href="/profile/1">My profile</a></header>
<div data-testid="event-profile.header.event-title">${GROUPS_EVENT_NAME}</div><a href="/events/${GROUPS_EVENT_ID}/draws?v=drawEditor">Event Desk</a><main>Event</main>`, 'text/html; charset=utf-8');
      }
      if (url.pathname === `/events/${GROUPS_EVENT_ID}/draws`) {
        return send(200, url.searchParams.get('v') === 'playersTab' ? playersTab(state) : drawPage(state, url.searchParams.get('d')), 'text/html; charset=utf-8');
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/group-draws') {
        const b = await body(req);
        const name = String(b.name ?? '').trim();
        if (!name) return send(400, { error: 'name required' });
        const draw: GroupsDraw = { id: `new-${next++}`, name, drawType: String(b.drawType), format: String(b.format), players: (b.players as number[]).slice().sort((x, y) => x - y) };
        state.draws.push(draw);
        return send(201, draw);
      }
      send(404, { error: 'not found' });
    } catch (error) { send(500, { error: (error as Error).message }); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, state, eventUrl: `${origin}/events/${GROUPS_EVENT_ID}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
