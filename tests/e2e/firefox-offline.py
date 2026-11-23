"""Offline X fixture for the built Firefox extension and the real local Collector."""
import base64
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Thread
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from collector.server import Collector, Handler

EXTENSION = Path(__file__).resolve().parents[2] / "dist" / "firefox"
FIREFOX = os.environ.get("NOAH_FIREFOX_BINARY", "/snap/firefox/current/usr/lib/firefox/firefox")
GECKODRIVER = os.environ.get("NOAH_GECKODRIVER", "/snap/firefox/current/usr/lib/firefox/geckodriver")
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=')
TOKEN = 'noah-firefox-fixture-token'
CHECK_GAPS = '--gaps' in sys.argv
GAP_PAGES = {}
blocked = False
source_attempts = []
origin_fetches = []

class Proxy(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def do_OPTIONS(self):
        self.forward()

    def forward(self):
        url = urlsplit(self.path)
        if url.netloc == '127.0.0.1:8765':
            conn = HTTPConnection('127.0.0.1', receiver.server_port, timeout=3)
            length = int(self.headers.get('Content-Length', 0))
            conn.request(self.command, url.path, self.rfile.read(length), dict(self.headers))
            result = conn.getresponse()
            self.send_response(result.status)
            for key, value in result.getheaders():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(result.read())
            conn.close()
            return
        if url.hostname not in ('x.com', 'pbs.twimg.com'):
            self.send_error(403)
            return
        if blocked:
            source_attempts.append(self.path)
            self.send_error(403)
            return
        if CHECK_GAPS and url.hostname == 'x.com' and url.path in GAP_PAGES:
            data = GAP_PAGES[url.path].encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
        elif url.hostname == 'x.com' and url.path == '/fixture/status/123456':
            data = (
                b'<link rel="icon" href="data:,">'
                b'<article><a href="/fixture/status/123456"><time>fixture</time></a>'
                b'<img id="target" crossorigin="anonymous" src="http://pbs.twimg.com/media/fixture.png">'
                b'<img id="tainted" src="http://pbs.twimg.com/media/tainted.png"></article>'
            )
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
        elif url.hostname == 'pbs.twimg.com':
            data = PNG
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Access-Control-Allow-Origin', '*')
        else:
            self.send_error(404)
            return
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

def start(server):
    Thread(target=server.serve_forever, daemon=True).start()

def fail_origin(*args):
    origin_fetches.append(args)
    raise AssertionError('origin fetch')

def gaps_extension(folder):
    fixture = subprocess.check_output([
        'node', '--input-type=module', '-e', """
import { fixturePage, gapsFixtureConfig } from "./gaps-fixture.mjs";
console.log(JSON.stringify({
  config: gapsFixtureConfig,
  pages: Object.fromEntries([1, 2, 3, 4].map((id) =>
    ["/gaps/item/" + id, fixturePage(id, { like: id === 1, images: [] })])),
}));
""",
    ], cwd=Path(__file__).resolve().parent)
    data = json.loads(fixture)
    GAP_PAGES.update(data['pages'])
    copy = shutil.copytree(EXTENSION, folder / 'extension')
    with (copy / 'sites.generated.js').open('a', encoding='utf-8') as out:
        out.write('\nATELIER_SITES.x = ' + json.dumps(data['config']) + ';\n')
    return copy


def check_gaps(command, collector):
    for item in range(1, 5):
        command('POST', '/url', {'url': f'http://x.com/gaps/item/{item}'})
        if item < 4:
            time.sleep(2.2)
            assert collector.diagnostics()['gaps_count'] == 0
    for _ in range(50):
        records = collector.diagnostics()['recent_gaps']
        if records:
            break
        time.sleep(.1)
    record, = records
    assert record['source'] == 'x' and record['action'] == 'like'
    assert not collector.recent()
    print('Firefox: gaps observation and authenticated Collector delivery passed')


with tempfile.TemporaryDirectory(prefix='noah-firefox-') as folder:
    root = Path(folder)
    extension = gaps_extension(root) if CHECK_GAPS else EXTENSION
    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as receiver, ThreadingHTTPServer(('127.0.0.1', 0), Proxy) as proxy:
        receiver.collector = Collector(root, TOKEN, download=False)
        receiver.collector._fetch_image = fail_origin
        start(receiver)
        start(proxy)
        with (root / 'gecko.log').open('w+') as log:
            driver = subprocess.Popen([GECKODRIVER, '--port', '0', '--allow-system-access'], stdout=log, stderr=log)
            sid = None
            try:
                for _ in range(50):
                    log.seek(0)
                    out = log.read()
                    if 'Listening on' in out:
                        address = out.split('Listening on ')[1].splitlines()[0]
                        break
                    time.sleep(.1)
                else:
                    raise RuntimeError(out)

                def call(method, route, body=None):
                    data = json.dumps(body).encode() if body is not None else None
                    request = Request('http://' + address + route, data, {'Content-Type':'application/json'}, method=method)
                    try:
                        with urlopen(request, timeout=20) as response:
                            return json.load(response)['value']
                    except HTTPError as error:
                        raise RuntimeError(error.read().decode()[:1000]) from None

                prefs = {'network.proxy.type':1, 'network.proxy.http':'127.0.0.1',
                         'network.proxy.http_port':proxy.server_port,
                         'network.proxy.ssl':'127.0.0.1',
                         'network.proxy.ssl_port':proxy.server_port,
                         'network.proxy.failover_direct':False,
                         'network.proxy.no_proxies_on':'',
                         'network.proxy.allow_hijacking_localhost':True,
                         'dom.security.https_first':False,
                         'dom.security.https_only_mode':False}
                caps = call('POST', '/session', {'capabilities':{'alwaysMatch':{'browserName':'firefox',
                    'moz:firefoxOptions':{'binary':FIREFOX,'args':['-headless'],'prefs':prefs}}}})
                sid = '/session/' + caps['sessionId']
                def command(method, route, body=None):
                    return call(method, sid + route, body)
                assert command('POST', '/moz/addon/install', {'path':str(extension),'temporary':True}) == 'atelier-capture@local'
                command('POST','/moz/context',{'context':'chrome'})
                addon_url = command('POST', '/execute/sync', {'script':'return WebExtensionPolicy.getByID("atelier-capture@local").getURL("options.html")','args':[]})
                command('POST','/moz/context',{'context':'content'})
                command('POST','/url',{'url':addon_url})
                def element(selector):
                    return next(iter(command('POST','/element',{'using':'css selector','value':selector}).values()))
                token = element('#token')
                command('POST', '/element/' + token + '/value', {'text':TOKEN})
                command('POST', '/element/' + element('#test') + '/click', {})
                for _ in range(30):
                    if '接続OK' in command('GET','/element/' + element('#status') + '/text'):
                        break
                    time.sleep(.1)
                else:
                    raise AssertionError('Collector connection test failed')
                command('POST','/element/' + element('#enabled') + '/click',{})
                command('POST','/element/' + element('#save') + '/click',{})
                time.sleep(.4)
                if CHECK_GAPS:
                    check_gaps(command, receiver.collector)
                else:
                    from app.core.inbox import InboxDB
                    command('POST','/url',{'url':'http://x.com/fixture/status/123456'})
                    blocked = True
                    command('POST','/element/' + element('#target') + '/click',{})
                    command('POST','/element/' + element('#tainted') + '/click',{})
                    for _ in range(30):
                        records = receiver.collector.recent()
                        if len(records) == 2:
                            break
                        time.sleep(.1)
                    assert len(records) == 2, records
                    image, = [record['images'][0] for record in records if record['images'][0].get('hash')]
                    assert (root / 'images' / (image['hash'] + '.png')).is_file()
                    failure, = [record['images'][0] for record in records if not record['images'][0].get('hash')]
                    assert failure['download_error'].startswith('cors_blocked')
                    assert not source_attempts and not origin_fetches, (source_attempts, origin_fetches)
                    db = InboxDB(root / 'inbox.sqlite')
                    assert db.import_collector(root) == 1
                    row, = db.queue()
                    assert db.thumb(row['id']) and db.collector_observations(row['id'])[0]['observation_route'] == 'image_click'
                    print('Firefox 159: offline image + observation, tainted image reason, source requests 0')
            finally:
                try:
                    if sid is not None:
                        call('DELETE', sid)
                finally:
                    driver.terminate()
                    driver.wait(timeout=10)
