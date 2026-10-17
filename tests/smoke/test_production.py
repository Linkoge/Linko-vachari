"""Production HTTP smoke, with no model calls or marketplace navigation."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest


@pytest.mark.smoke
def test_production_shell_and_private_api():
    root = Path(__file__).resolve().parents[2]
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory(prefix="linko-smoke-") as data_dir, tempfile.TemporaryFile() as log:
        env = dict(os.environ, NODE_ENV="production", HOST="127.0.0.1", PORT=str(port),
                   LINKO_DATA_DIR=data_dir, LINKO_PUBLIC_ORIGIN="", LINKO_PANEL_AUTH="false",
                   LINKO_RELEASE_ID="isolated-smoke", ALLOW_PUBLISH="false", HEADLESS="true")
        process = subprocess.Popen(["node", "--import", "tsx", "server/index.ts"], cwd=root,
                                   env=env, stdout=log, stderr=log, start_new_session=True)
        try:
            for _ in range(150):
                assert process.poll() is None, "Isolated production server stopped before becoming ready"
                try:
                    with urlopen(base + "/api/health", timeout=1) as response:
                        health = json.load(response)
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                pytest.fail("Isolated production server did not become ready")
            assert health["releaseId"] == "isolated-smoke"
            assert health["publishingEnabled"] is False
            with urlopen(base) as response:
                shell = response.read().decode()
                assert response.status == 200 and 'id="root"' in shell
            with urlopen(base + "/manifest.webmanifest") as response:
                manifest = json.load(response)
                assert manifest["display"] == "standalone"
            for icon in manifest["icons"]:
                with urlopen(base + "/" + icon["src"].lstrip("/")) as response:
                    assert response.read().startswith(b"\x89PNG\r\n\x1a\n")
            with urlopen(base + "/sw.js") as response:
                worker = response.read().decode()
                assert "/assets/" in worker and "/api/" in worker
            with urlopen(base + "/api/auth/status") as response:
                assert response.headers["Cache-Control"] == "no-store"
            bad = Request(base + "/api/drafts", data=b"{}", method="POST",
                          headers={"Origin": "https://untrusted.example", "X-Linko-Request": "1",
                                   "Content-Type": "application/json"})
            with pytest.raises(HTTPError) as denied:
                urlopen(bad)
            assert denied.value.code == 403
            create = Request(base + "/api/drafts", data=b"{}", method="POST",
                             headers={"X-Linko-Request": "1", "Content-Type": "application/json"})
            with urlopen(create) as response:
                draft = json.load(response)
                assert response.status == 201 and draft["state"] == "draft"
                assert response.headers["Cache-Control"] == "no-store"
            receipt = {"checkedAt": datetime.now(timezone.utc).isoformat(), "passed": True,
                       "kind": "isolated production HTTP smoke", "shell": 200,
                       "standaloneManifest": True, "pngIcons": len(manifest["icons"]),
                       "hashedAssetsPrecached": True, "privateApiNoStore": True,
                       "crossOriginWriteDenied": True, "draftCreation": 201,
                       "publishingEnabled": False, "modelCalls": 0,
                       "marketplaceRequests": 0, "temporaryRuntime": True,
                       "deploymentPerformed": False}
            if os.environ.get("LINKO_SMOKE_RECEIPT"):
                Path(os.environ["LINKO_SMOKE_RECEIPT"]).write_text(json.dumps(receipt, indent=2) + "\n")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
