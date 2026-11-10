#!/bin/bash
# Run the dict-learn PIXEL E2E tour from a NORMAL (non-sandboxed) terminal.
# The AgnesCode sandbox blocks native browser rendering at the OS level
# (Chromium mach-SEGV, WebKit hang, QEMU no Hypervisor). This script does the
# same E2E tour in a real headless WebKit and saves every screen to out/e2e/,
# where AgnesCode can then read_image-review and polish the UI.
#
# Usage (from the repo root, in your own Terminal.app):
#   bash .e2e/run_pixel_e2e.sh
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"
export TMPDIR="$PWD/.e2e/tmp"; mkdir -p "$TMPDIR"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.e2e/browsers"

# 1) playwright + webkit (already installed; re-installs only if missing)
if [ ! -d "$PWD/.e2e/browsers/webkit-2248" ]; then
  (cd .e2e && /opt/homebrew/bin/npx playwright install webkit)
fi

# 2) static server for mobile/www (port 8787)
/opt/homebrew/bin/node -e "fetch('http://127.0.0.1:8787/version.json').then(r=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null || {
  nohup /opt/homebrew/bin/node -e "
const http=require('http'),fs=require('fs'),path=require('path');
const root='$PWD/mobile/www';
const mt={'.html':'text/html','.js':'text/javascript','.json':'application/json','.png':'image/png','.wasm':'application/wasm','.manifest':'application/manifest+json'};
http.createServer((req,res)=>{let p=req.url.split('?')[0];if(p==='/')p='/index.html';const f=path.join(root,decodeURIComponent(p));fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);res.end('404');return;}res.writeHead(200,{'Content-Type':mt[path.extname(f)]||'application/octet-stream','Access-Control-Allow-Origin':'*'});res.end(d);});}).listen(8787,'127.0.0.1');setTimeout(()=>{},1e9);" > out/node_server.log 2>&1 &
  sleep 2
}
/opt/homebrew/bin/node -e "fetch('http://127.0.0.1:8787/version.json').then(r=>console.log('server ready:',r.status)).catch(e=>{console.error('server failed:',e.message);process.exit(1)})"

# 3) the tour
cd .e2e
/opt/homebrew/bin/node e2e_pixel.mjs
echo
echo "=== screenshots in out/e2e/ ==="
ls -la ../out/e2e/*.png 2>/dev/null
echo "Done. Tell AgnesCode 'chụp xong' so it can read_image-review."
