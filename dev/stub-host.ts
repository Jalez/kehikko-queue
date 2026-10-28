#!/usr/bin/env bun
/**
 * A host that is not a host, for looking at this module the way it is used,
 * before you install it in Kehikot:
 *
 *   bun run stub                       # then open the address it prints
 *   STUB_PROJECT=/path/to/a/project bun run stub
 *
 * It starts this module (`vite`, with `KEHIKOT_ORIGINS` naming the stub, so the
 * page lets the stub frame it and the MCP door asks the stub which folders are
 * projects, and with a throwaway registry, so Kehikot never hears of this copy) and serves one page that frames it the way Kehikot does: the
 * greeting with a project, an epic and three parts, the header drawn from what
 * the module declares (press a switch and see it come back), the Inbox items it
 * reports, and every message logged. Pick parts with the buttons.
 *
 * Nothing here is shipped, and nothing in `src/` knows it exists. It is no
 * substitute for the real host: install the module there too (README, "Try it").
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MESSAGE, PROTOCOL } from 'kehikot-module-protocol'
import { originFor } from 'kehikot-module-protocol/serve'

import { PREFERRED_PORT } from '../manifest.ts'

/* Inside this module's ten-port slot, so it never lands on a neighbour. */
const PORT = Number(process.env.STUB_PORT ?? PREFERRED_PORT + 9)
const STUB = originFor(PORT)
const MODULE = originFor(PREFERRED_PORT)
const PROJECT = process.env.STUB_PROJECT ?? process.cwd()

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>stub host</title>
<style>
  body { font: 13px system-ui; margin: 0; display: grid; grid-template-columns: minmax(0, 1fr) 320px; height: 100vh }
  header { grid-column: 1 / -1; padding: 6px 10px; border-bottom: 1px solid #ccc; display: flex; gap: 8px; flex-wrap: wrap; align-items: center }
  iframe { width: 100%; height: 100%; border: 0 }
  aside { border-left: 1px solid #ccc; overflow: auto; padding: 6px; font: 11px ui-monospace, monospace; white-space: pre-wrap }
  #menus button.on { font-weight: bold }
</style></head>
<body>
  <header>
    <strong>stub host</strong>
    <span id="where"></span>
    <span>parts:</span><span id="parts"></span>
    <span>header:</span><span id="menus">(nothing declared)</span>
    <span>inbox:</span><span id="inbox">(nothing reported)</span>
  </header>
  <iframe id="frame" sandbox="allow-scripts allow-forms allow-same-origin" src="${MODULE}/app"></iframe>
  <aside id="log"></aside>
<script>
(function () {
  var frame = document.getElementById('frame');
  var log = document.getElementById('log');
  var parts = [
    { id: 'design', heading: 'Design', refs: [], picked: false },
    { id: 'build', heading: 'Build', refs: [], picked: false },
    { id: 'ship', heading: 'Ship', refs: [], picked: false }
  ];
  var kept = null;
  var presses = 0;
  function say(line) { log.textContent = line + '\\n' + log.textContent; }
  function context() {
    return { epic: 'try-the-module', project: ${JSON.stringify(PROJECT.split('/').pop())}, projectPath: ${JSON.stringify(PROJECT)},
      theme: 'light', parts: parts, selection: [] };
  }
  function send(message) { frame.contentWindow.postMessage(message, '${MODULE}'); }
  function tell() { send(Object.assign({ type: '${MESSAGE.CONTEXT}', protocol: ${PROTOCOL} }, context())); }
  document.getElementById('where').textContent = ${JSON.stringify(PROJECT)} + ' › try-the-module';
  function drawParts() {
    var box = document.getElementById('parts');
    box.textContent = '';
    parts.forEach(function (part) {
      var b = document.createElement('button');
      b.textContent = (part.picked ? '✓ ' : '') + part.heading;
      b.onclick = function () { part.picked = !part.picked; drawParts(); tell(); };
      box.appendChild(b);
    });
  }
  drawParts();
  /* The header, drawn from the module's declaration as plain text and buttons: a module's strings are text. */
  function drawMenus(items) {
    var box = document.getElementById('menus');
    box.textContent = '';
    items.forEach(function (item) {
      (item.options || [{ id: null, label: item.label }]).forEach(function (option) {
        var b = document.createElement('button');
        b.textContent = item.label + (option.id ? ': ' + option.label : '');
        if (item.kind === 'switch' && item.value === option.id) b.className = 'on';
        b.onclick = function () {
          var value = item.kind === 'toggle' ? !item.checked : option.id;
          send({ type: '${MESSAGE.PRESS}', protocol: ${PROTOCOL}, id: 'press-' + (++presses), item: item.id, value: value === null ? undefined : value });
        };
        box.appendChild(b);
      });
    });
  }
  frame.addEventListener('load', function () {
    send({ type: '${MESSAGE.HELLO}', protocol: ${PROTOCOL}, session: 'stub', context: context(), state: kept,
      answers: ['state.set', 'activity.set'], header: true });
  });
  addEventListener('message', function (event) {
    if (event.source !== frame.contentWindow) return;
    var d = event.data;
    if (!d || typeof d.type !== 'string') return;
    say(JSON.stringify(d));
    if (d.type === '${MESSAGE.HEADER}') return drawMenus(d.items || []);
    if (d.type !== '${MESSAGE.REQUEST}') return;
    var answer = function (data) { send({ type: '${MESSAGE.RESPONSE}', id: d.id, ok: true, data: data }); };
    if (d.method === 'state.set') { kept = d.params.state; return answer(null); }
    if (d.method === 'activity.set') {
      var items = d.params.items || [];
      document.getElementById('inbox').textContent = items.length ? items.map(function (i) { return i.state + ': ' + i.label; }).join(' | ') : '(empty)';
      return answer({ outcome: 'taken', taken: items.length, why: '' });
    }
    send({ type: '${MESSAGE.RESPONSE}', id: d.id, ok: false, reason: 'unknown-method', error: 'the stub host answers state.set and activity.set' });
  });
})();
</script></body></html>`

const json = (body: unknown) => Response.json(body)

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url)
    /* What a module's door asks a host: is this folder a project (2.3.0)? Here, the one project. */
    if (url.pathname === '/host/is-project') {
      const path = url.searchParams.get('path')
      return json(path === PROJECT ? { ok: true, project: true, path } : { ok: true, project: false, why: `${path} is not the stub's project.` })
    }
    /* No conversation has a recorded place here. */
    if (url.pathname === '/host/place') return json({ ok: true, place: null })
    return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  },
})

const module = Bun.spawn(['bunx', 'vite'], {
  cwd: `${import.meta.dirname}/..`,
  /* A registry of its own: a module's dev server registers itself, and this one must not land in Kehikot's. */
  env: { ...process.env, KEHIKOT_ORIGINS: STUB, PORT: String(PREFERRED_PORT), KEHIKOT_MODULES_DIR: mkdtempSync(join(tmpdir(), 'kehikot-stub-registry-')) },
  stdout: 'inherit',
  stderr: 'inherit',
})
const stop = () => {
  module.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

console.log(`stub host: ${STUB}  (framing ${MODULE}/app, project ${PROJECT})`)
