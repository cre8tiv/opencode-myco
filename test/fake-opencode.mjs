// Stands in for `opencode api --standalone [--param k=v]... GET <path>`, answering from a JSON file
// named by FAKE_OPENCODE_DB: {sessions: [info], contexts: {id: [messages]}}. The project is the cwd.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const params = {};
let i = args.indexOf('--standalone') + 1;
while (args[i] === '--param') {
  const [k, ...v] = args[i + 1].split('=');
  params[k] = v.join('=');
  i += 2;
}
const [method, path] = args.slice(i);
if (args[0] !== 'api' || method !== 'GET') {
  console.error('fake opencode: unsupported ' + args.join(' '));
  process.exit(2);
}
const db = JSON.parse(readFileSync(process.env.FAKE_OPENCODE_DB, 'utf8'));
const out = (v) => console.log(JSON.stringify(v));
let m;
if (path === '/api/project') out({ data: [{ id: 'proj-1', canonical: process.cwd(), sandboxes: [] }] });
else if (path === '/api/session') out({ data: db.sessions.filter((s) => s.project === params.project), cursor: {} });
else if ((m = path.match(/^\/api\/session\/([^/]+)\/context$/))) out({ data: db.contexts[m[1]] || [] });
else if ((m = path.match(/^\/api\/session\/([^/]+)$/))) {
  const found = db.sessions.find((s) => s.id === m[1]);
  if (!found) {
    console.error('fake opencode: no session ' + m[1]);
    process.exit(1);
  }
  out({ data: found });
}
else {
  console.error('fake opencode: no route ' + path);
  process.exit(1);
}
