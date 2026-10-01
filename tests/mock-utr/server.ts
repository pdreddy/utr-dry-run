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
export interface MockState { eventId: number; eventName: string; players: string[]; matches: MockMatch[]; writes: { method: string; path: string }[] }

export const EVENT_ID = 388079;
export const EVENT_NAME = 'UTR Dry Run Junior Open';
const PLAYERS = [
  'Pranav V', 'Pranav Vijay', 'Ridit Sarkar', 'Iraj Kotru', 'Rithva Kanakaraj', 'Pritish Singhal', 'Aarohi Mara',
  'Venkata Aarush Tellabati', 'Vansh Sambara', 'Prajwal Aripaka', 'Venkata Ram Dheeraj Nagulakonda',
  'Ranveer Kalavakolanu', 'Saatvik Mishra', 'Harsha Vennapusa', 'Dhruvin Saladi', 'Sai Mukunth Kuppan',
  'Viswesh Vasu', 'Aarav Shah', 'Aarav Shah'
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

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

export async function startMockUtr(port = 0): Promise<{ origin: string; eventUrl: string; state: MockState; close(): Promise<void> }> {
  const state: MockState = { eventId: EVENT_ID, eventName: EVENT_NAME, players: PLAYERS, matches: [], writes: [] };
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
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/profile'))) {
        return send(200, '<!doctype html><title>UTR</title><a data-testid="user-menu" href="/profile/1">My profile</a><main>Home</main>', 'text/html');
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/players') {
        const query = (url.searchParams.get('query') ?? '').toLowerCase();
        return send(200, state.players.map((name, id) => ({ id: String(id), name, rating: (7 + (id % 5) / 2).toFixed(2) }))
          .filter(p => query.length >= 2 && p.name.toLowerCase().includes(query)));
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
