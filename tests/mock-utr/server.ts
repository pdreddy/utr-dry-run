/**
 * A local stand-in for a UTR event's director view, used to rehearse the full
 * automation end to end. It renders match cards (players in rows, set scores
 * per player like UTR's draw), a typeahead "Add Match" dialog, a per-match
 * score dialog, and a JSON API that rejects duplicate matches.
 *
 *   node --experimental-strip-types tests/mock-utr/server.ts   # manual demo on :4510
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import process from 'node:process';
import path from 'node:path';

export interface MockMatch { id: number; round: string; a: string; b: string; score?: { a: number[]; b: number[] } }
export interface EditorSlot { a?: string; b?: string; score?: { a: number[]; b: number[] } }
export interface MockState {
  eventId: number; eventName: string; players: string[]; matches: MockMatch[]; writes: { method: string; path: string }[];
  /**
   * Event Desk draw editor: 8 Round of 16 slots and 4 quarterfinal slots that fill from
   * results, plus the draw's roster. Like the real editor, a player must be added to
   * `roster` (via the sidebar's "Add to Draw") before the match-card picker can find them.
   */
  editor: { r16: EditorSlot[]; qf: EditorSlot[]; published: boolean; roster: number[] };
}

export const EVENT_ID = 388079;
export const EVENT_NAME = 'UTR Dry Run Junior Open';
const PLAYERS = [
  'Pranav V', 'Pranav Vijay', 'Ridit Sarkar', 'Iraj Kotru', 'Rithva Kanakaraj', 'Pritish Singhal', 'Aarohi Mara',
  'Venkata Aarush Tellabati', 'Vansh Sambara', 'Prajwal Aripaka', 'Venkata Ram Dheeraj Nagulakonda',
  'Ranveer Kalavakolanu', 'Saatvik Mishra', 'Harsha Vennapusa', 'Dhruvin Saladi', 'Sai Mukunth Kuppan',
  'Viswesh Vasu', 'Aarav Shah', 'Aarav Shah', 'Pranav Vommi', 'Sai Mukunth Kuppan Saravanan'
];
const ROUNDS = ['Round of 16', 'Quarterfinals', 'Semifinals', 'Final'];

const escapeHtml = (value: string) => value.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function eventHtml(state: MockState): string {
  const cards = state.matches.map(m => `
    <div data-testid="match-card" data-match-id="${m.id}" class="match">
      <div class="round">${escapeHtml(m.round)}</div>
      <div class="row"><span class="name">${escapeHtml(m.a)}</span>${m.score ? m.score.a.map(s => `<span class="set">${s}</span>`).join('') : ''}</div>
      <div class="row"><span class="name">${escapeHtml(m.b)}</span>${m.score ? m.score.b.map(s => `<span class="set">${s}</span>`).join('') : ''}</div>
      <a href="/matches/${m.id}">Details</a>
      <button type="button" data-score="${m.id}">${m.score ? 'Edit Score' : 'Enter Score'}</button>
    </div>`).join('');
  return `<!doctype html><html><head><title>${escapeHtml(state.eventName)} | UTR</title>
<style>.row{display:block}.set{margin-left:8px}.match{border:1px solid #ccc;margin:6px;padding:6px;width:320px}
[role=dialog]{position:fixed;top:40px;left:380px;background:#fff;border:2px solid #333;padding:12px}</style></head>
<body><header><a data-testid="user-menu" href="/profile/1">My profile</a></header>
<main><h1>${escapeHtml(state.eventName)}</h1><nav><a href="#">Draws</a></nav>
<button type="button" id="add">Add Match</button><section id="matches">${cards}</section></main>
<script>
const api = (method, url, body) => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  .then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); });
function dialog(html) { const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.innerHTML = html; document.body.append(d); return d; }
function typeahead(input, onPick) {
  const list = document.createElement('ul'); list.setAttribute('role', 'listbox'); input.after(list);
  input.addEventListener('input', async () => {
    const names = await fetch('/api/v1/players?query=' + encodeURIComponent(input.value)).then(r => r.json());
    list.innerHTML = '';
    names.forEach((p, i) => { const li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = p.name + '\\n' + p.rating;
      li.onclick = () => { input.value = p.name; input.dataset.playerId = p.id; list.innerHTML = ''; onPick(); }; list.append(li); });
  });
}
document.getElementById('add').onclick = () => {
  const d = dialog('<h2>Add Match</h2><label>Player 1 <input aria-label="Player 1" placeholder="Search player"></label>' +
    '<label>Player 2 <input aria-label="Player 2" placeholder="Search player"></label>' +
    '<label>Round <select aria-label="Round"><option></option>${ROUNDS.map(r => `<option>${r}</option>`).join('')}</select></label>' +
    '<button type="button" id="create">Create Match</button>');
  const [a, b] = d.querySelectorAll('input'); typeahead(a, () => {}); typeahead(b, () => {});
  d.querySelector('#create').onclick = () => api('POST', '/api/v1/event/${state.eventId}/matches', { playerAId: a.dataset.playerId, playerBId: b.dataset.playerId, round: d.querySelector('select').value })
    .then(() => setTimeout(() => location.reload(), 150)).catch(e => alert(e.message));
};
document.querySelectorAll('[data-score]').forEach(button => button.onclick = () => {
  const id = button.dataset.score;
  let html = '<h2>Enter Score</h2>';
  for (let s = 1; s <= 3; s++) html += '<div>Set ' + s + ' <input type="number" aria-label="Set ' + s + ' Player 1"> <input type="number" aria-label="Set ' + s + ' Player 2"></div>';
  const d = dialog(html + '<button type="button" id="save">Save Score</button>');
  d.querySelector('#save').onclick = () => {
    const sets = [1, 2, 3].map(s => [d.querySelector('[aria-label="Set ' + s + ' Player 1"]').value, d.querySelector('[aria-label="Set ' + s + ' Player 2"]').value]).filter(([x, y]) => x !== '' && y !== '');
    api('PUT', '/api/v1/match/' + id + '/score', { sets: sets.map(([x, y]) => ({ a: Number(x), b: Number(y) })) }).then(() => location.reload()).catch(e => alert(e.message));
  };
});
</script></body></html>`;
}

function editorHtml(state: MockState): string {
  const winner = (slot: EditorSlot): string | undefined => {
    if (!slot.a || !slot.b || !slot.score) return undefined;
    const aSets = slot.score.a.filter((x, i) => x > slot.score!.b[i]!).length;
    return aSets > slot.score.a.length / 2 ? slot.a : slot.b;
  };
  const card = (round: string, i: number, slot: EditorSlot) => `
    <div class="card" data-round="${round}" data-n="${i + 1}">
      <a href="#" class="dt">Set Date &amp; Time</a><span class="mn">Match #${i + 1}</span>
      <div class="slots">
        ${[slot.a, slot.b].map((name, k) => `<div class="slot"><span class="pn">${name ? escapeHtml(name) : '<span class="empty" data-slot="' + k + '">Select a player</span>'}</span>${slot.score && name ? (k === 0 ? slot.score.a : slot.score.b).map(v => `<span class="set">${v}</span>`).join('') : ''}</div>`).join('')}
        <button type="button" class="scorebtn" data-round="${round}" data-n="${i + 1}">Score</button>
      </div><div class="more">...</div>
    </div>`;
  const qf = state.editor.qf.map((slot, i) => {
    const feed = (k: number) => winner(state.editor.r16[i * 2 + k]!);
    return card('qf', i, { ...slot, a: feed(0), b: feed(1) });
  }).join('');
  const r16 = state.editor.r16.map((slot, i) => card('r16', i, slot)).join('');
  return `<section><h2>Round of 16</h2>${r16}</section><section><h2>Quarterfinals</h2>${qf}</section>`;
}

function rosterHtml(state: MockState, query = ''): string {
  const q = query.trim().toLowerCase();
  // Not deduplicated by name: two different players can share a display name, and the
  // roster must show (and let the automation tell apart) each one separately.
  const notInDraw = state.players.map((name, index) => ({ name, index })).filter(p => !state.editor.roster.includes(p.index));
  const shown = q ? notInDraw.filter(p => p.name.toLowerCase().includes(q)) : notInDraw;
  const placed = state.editor.roster.map(index => state.players[index]!);
  // Like the real sidebar: checkbox, name + rating, city, and a trailing "..." that opens the row menu.
  const row = (p: { name: string; index: number }) => `<li class="prow"><input type="checkbox">` +
    `<div class="pinfo"><div><b>${escapeHtml(p.name)}</b> <small>${(7 + (p.index % 5) / 2).toFixed(2)}</small></div><div>Prosper, TX</div></div>` +
    `<span class="more" data-index="${p.index}">...</span></li>`;
  return `<div class="sec">PLACED (${placed.length})</div><ul class="placed">${placed.map(name => `<li><b>${escapeHtml(name)}</b></li>`).join('')}</ul>` +
    `<div class="sec" id="nidHeader">PLAYERS NOT IN DRAW (${notInDraw.length})</div><ul id="roster" style="display:none">${shown.map(row).join('')}</ul>`;
}

function editorPage(state: MockState): string {
  return `<!doctype html><html><head><title>${escapeHtml(state.eventName)} | UTR</title>
<style>.cols{display:flex;gap:40px}.card{border:1px solid #ccc;margin:8px;padding:8px;width:340px}.slot{display:block;margin:4px 0}.set{margin-left:10px}
.empty{color:#d0107c;cursor:pointer}ul.dd{border:1px solid #333;background:#fff;list-style:none;padding:0;margin:2px;max-height:160px;overflow:auto}ul.dd li{padding:4px;cursor:pointer}
#roster,.placed{list-style:none;padding:0}#roster li{padding:4px;display:flex;gap:8px}.more{cursor:pointer;margin-left:auto}.sec{cursor:pointer;background:#ddd;padding:6px}
.rowmenu{border:1px solid #333;background:#fff;padding:4px;position:absolute}
[role=dialog]{position:fixed;top:60px;left:420px;background:#fff;border:2px solid #333;padding:12px}</style></head>
<body><header><a data-testid="user-menu" href="/profile/1">My profile</a></header>
<h1>${escapeHtml(state.eventName)}</h1>
<nav><button type="button" id="rail">Draws</button></nav><div><ul class="side" id="side" style="display:none"><li id="g1">Group 01</li><li id="po">Playoff</li></ul></div>
<div id="groupView"><div>Round Robin, Co-ed, Two Sets w/ Match Tiebreaker, 8 Players</div><h2>Round 1</h2>
  <div class="card"><span class="mn">Match #1</span><div class="slot">Pritish Singhal</div><div class="slot">Bye</div><button type="button">Score</button></div></div>
<div id="playoffView" style="display:none"><div>Single Elimination, Co-ed, Two Sets w/ Match Tiebreaker, 16 Players</div><span id="saved">Saved</span> <button type="button" id="publish">PUBLISH</button>
<div style="display:flex;gap:24px"><aside style="width:320px;flex:none"><input placeholder="Filter Players" id="pfilter">
<div id="rosterPanel">${rosterHtml(state)}</div></aside>
<div class="cols">${editorHtml(state)}</div></div></div>
<script>
// Like the real editor, a fresh load always shows the default draw (Group 01) until Playoff is chosen.
document.getElementById('rail').onclick = () => { const l = document.getElementById('side'); l.style.display = l.style.display === 'none' ? 'block' : 'none'; };
document.getElementById('po').onclick = () => { document.getElementById('groupView').style.display = 'none'; document.getElementById('playoffView').style.display = 'block'; };
const call = (method, url, body) => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); });
document.getElementById('publish').onclick = () => call('POST', '/api/v1/draw/publish', {}).then(refresh);
// Like the real editor's autosave, a slot pick or score save updates the bracket in place, with no page reload.
async function refresh() { document.querySelector('.cols').innerHTML = (await fetch('/api/v1/draw/fragment').then(r => r.json())).html; bind(); }
async function refreshRoster() { document.getElementById('rosterPanel').innerHTML = (await fetch('/api/v1/draw/roster/html?query=' + encodeURIComponent(document.getElementById('pfilter').value)).then(r => r.json())).html; bindRoster(); }
document.getElementById('pfilter').addEventListener('input', refreshRoster);
// Like the real sidebar, "Players not in draw" starts collapsed (and says nothing about it
// through aria-expanded); clicking its header toggles it, and it stays as left across refreshes.
let notInDrawOpen = false;
function bindRoster() {
  document.getElementById('roster').style.display = notInDrawOpen ? 'block' : 'none';
  document.getElementById('nidHeader').onclick = () => { notInDrawOpen = !notInDrawOpen; document.getElementById('roster').style.display = notInDrawOpen ? 'block' : 'none'; };
  document.querySelectorAll('#roster .more').forEach(button => button.onclick = () => {
    document.querySelectorAll('.rowmenu').forEach(x => x.remove());
    const menu = document.createElement('div'); menu.className = 'rowmenu';
    menu.innerHTML = '<div class="mi" role="menuitem">Add to Draw</div><div class="mi" role="menuitem">View Profile</div>';
    menu.querySelector('.mi').onclick = () => call('POST', '/api/v1/draw/roster', { index: Number(button.dataset.index) }).then(() => { notInDrawOpen = false; refreshRoster(); refresh(); }); // the sidebar re-renders collapsed
    button.after(menu);
  });
}
bindRoster();
function bind() {
  // Like the real picker, this is type-to-filter and only searches this draw's roster:
  // it shows "No players to add..." for a player not yet added to the draw, however typed.
  document.querySelectorAll('.empty').forEach(el => el.onclick = () => {
    document.querySelectorAll('.picker').forEach(x => x.remove());
    const card = el.closest('.card'), round = card.dataset.round, n = card.dataset.n, slotKey = el.dataset.slot;
    const picker = document.createElement('div'); picker.className = 'picker';
    picker.innerHTML = '<input placeholder="Type to filter players...">' +
      '<div class="results">No players to add...</div>' +
      '<div class="quick"><button type="button">Clear</button><button type="button">Bye</button></div>';
    el.replaceWith(picker);
    const input = picker.querySelector('input'), results = picker.querySelector('.results');
    input.addEventListener('input', async () => {
      const q = input.value.trim();
      if (q.length < 2) { results.textContent = 'No players to add...'; return; }
      const names = await fetch('/api/v1/draw/players?query=' + encodeURIComponent(q)).then(r => r.json());
      if (!names.length) { results.textContent = 'No players to add...'; return; }
      results.innerHTML = '';
      const list = document.createElement('ul'); list.setAttribute('role', 'listbox');
      names.forEach(p => { const li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = p.name + '\\n' + p.rating;
        li.onclick = () => call('PUT', '/api/v1/draw/' + round + '/' + n + '/slot', { slot: slotKey, name: p.name }).then(refresh).catch(e => alert(e.message)); list.append(li); });
      results.append(list);
    });
    input.focus();
  });
  document.querySelectorAll('.scorebtn').forEach(button => button.onclick = () => {
    const d = document.createElement('div'); d.setAttribute('role', 'dialog');
    let html = '<h2>Score</h2>'; for (let s = 0; s < 3; s++) html += '<div><input type="number"> <input type="number"></div>';
    d.innerHTML = html + '<button type="button" id="savescore">Save</button>'; document.body.append(d);
    d.querySelector('#savescore').onclick = () => { const inputs = [...d.querySelectorAll('input')]; const sets = [];
      for (let s = 0; s < 3; s++) if (inputs[s*2].value !== '' && inputs[s*2+1].value !== '') sets.push({ a: Number(inputs[s*2].value), b: Number(inputs[s*2+1].value) });
      call('PUT', '/api/v1/draw/' + button.dataset.round + '/' + button.dataset.n + '/score', { sets }).then(() => { d.remove(); refresh(); }).catch(e => alert(e.message)); };
  });
}
bind();
</script></body></html>`;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

export async function startMockUtr(port = 0): Promise<{ origin: string; eventUrl: string; state: MockState; close(): Promise<void> }> {
  const state: MockState = { eventId: EVENT_ID, eventName: EVENT_NAME, players: PLAYERS, matches: [], writes: [], editor: { r16: Array.from({ length: 8 }, () => ({})), qf: Array.from({ length: 4 }, () => ({})), published: false, roster: [] as number[] } };
  let nextId = 9001;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      if (req.method !== 'GET') state.writes.push({ method: req.method!, path: url.pathname });
      if (req.method === 'GET' && url.pathname === `/events/${EVENT_ID}`) return send(200, eventHtml(state), 'text/html');
      if (req.method === 'GET' && url.pathname === `/events/${EVENT_ID}/draws`) return send(200, editorPage(state), 'text/html');
      if (req.method === 'GET' && url.pathname === '/api/v1/draw/fragment') return send(200, { html: editorHtml(state) });
      if (req.method === 'GET' && url.pathname === '/api/v1/draw/roster/html') return send(200, { html: rosterHtml(state, url.searchParams.get('query') ?? '') });
      if (req.method === 'POST' && url.pathname === '/api/v1/draw/roster') {
        const body = await readJson(req);
        const index = Number(body.index);
        if (!Number.isInteger(index) || !state.players[index]) return send(400, { error: 'unknown player' });
        if (state.editor.roster.includes(index)) return send(409, { error: 'already in draw' });
        state.editor.roster.push(index);
        return send(200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/draw/players') {
        const query = (url.searchParams.get('query') ?? '').toLowerCase();
        return send(200, state.editor.roster.filter(index => query.length >= 2 && state.players[index]!.toLowerCase().includes(query))
          .map(index => ({ id: String(index), name: state.players[index]!, rating: (7 + (index % 5) / 2).toFixed(2) })));
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/draw/publish') { state.editor.published = true; return send(200, { ok: true }); }
      const slotRoute = url.pathname.match(/^\/api\/v1\/draw\/(r16|qf)\/(\d+)\/(slot|score)$/);
      if (req.method === 'PUT' && slotRoute) {
        const slots = state.editor[slotRoute[1] as 'r16' | 'qf'], slot = slots[Number(slotRoute[2]) - 1];
        const body = await readJson(req);
        if (!slot) return send(404, { error: 'unknown match' });
        if (slotRoute[3] === 'slot') {
          const key = String(body.slot) === '0' ? 'a' : 'b';
          if (!state.editor.roster.some(index => state.players[index] === String(body.name))) return send(400, { error: 'player is not on the draw roster' });
          if (Object.values(state.editor.r16).some(m => m.a === body.name || m.b === body.name)) return send(409, { error: 'player already placed' });
          slot[key] = String(body.name); return send(200, { ok: true });
        }
        const sets = (body.sets ?? []) as { a: number; b: number }[];
        if (!slot.a || !slot.b) return send(409, { error: 'players not set' });
        if (!sets.length || sets.some(x => x.a === x.b)) return send(400, { error: 'invalid score' });
        slot.score = { a: sets.map(x => x.a), b: sets.map(x => x.b) }; return send(200, { ok: true });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/profile'))) {
        return send(200, '<!doctype html><title>UTR</title><a data-testid="user-menu" href="/profile/1">My profile</a><main>Home</main>', 'text/html');
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/players') {
        const query = (url.searchParams.get('query') ?? '').toLowerCase();
        return send(200, state.players.map((name, id) => ({ id: String(id), name, rating: (7 + (id % 5) / 2).toFixed(2) }))
          .filter(p => query.trim() === '' || (query.length >= 2 && p.name.toLowerCase().includes(query))));
      }
      if (req.method === 'POST' && url.pathname === `/api/v1/event/${EVENT_ID}/matches`) {
        const body = await readJson(req);
        const a = state.players[Number(body.playerAId)], b = state.players[Number(body.playerBId)];
        if (!a || !b || !body.round) return send(400, { error: 'players and round are required' });
        if (state.matches.some(m => [m.a, m.b].sort().join('|') === [a, b].sort().join('|'))) return send(409, { error: 'duplicate match' });
        const match = { id: nextId++, round: String(body.round), a, b };
        state.matches.push(match);
        return send(201, { match: { id: match.id } });
      }
      const score = url.pathname.match(/^\/api\/v1\/match\/(\d+)\/score$/);
      if (req.method === 'PUT' && score) {
        const match = state.matches.find(m => m.id === Number(score[1]));
        const sets = ((await readJson(req)).sets ?? []) as { a: number; b: number }[];
        if (!match) return send(404, { error: 'unknown match' });
        if (!sets.length || sets.some(s => s.a === s.b)) return send(400, { error: 'invalid score' });
        match.score = { a: sets.map(s => s.a), b: sets.map(s => s.b) };
        return send(200, { id: match.id });
      }
      send(404, { error: 'not found' });
    } catch (error) {
      send(500, { error: (error as Error).message });
    }
  });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin, state,
    eventUrl: `${origin}/events/${EVENT_ID}?d=d08a5733-d994-4060-b284-d9281979f69e&r=0&t=4`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const mock = await startMockUtr(Number(process.env.PORT || 4510));
  console.log(`Mock UTR event: ${mock.eventUrl}\nUTR_EVENT_NAME=${EVENT_NAME}`);
}
