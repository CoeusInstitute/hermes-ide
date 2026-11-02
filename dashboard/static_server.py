"""Static preview server for the Hermes IDE: one folder on 127.0.0.1, for the IDE's own browser.

Unlike ``python -m http.server`` it never serves dotfiles or dot folders (.env, .git), never lists a
folder, and answers only a localhost Host header, so a web page elsewhere cannot read the project
through DNS rebinding.

    python static_server.py <port> <folder>
"""

from __future__ import annotations

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def allowed(host_header: str, path: str) -> int:
    """0 to serve, else the HTTP status to refuse with."""
    host = host_header.strip().lower()
    host = host[1:host.index("]")] if host.startswith("[") and "]" in host else host.rsplit(":", 1)[0]
    if host not in LOCAL_HOSTS:
        return 403
    if any(part.startswith(".") for part in unquote(urlsplit(path).path).replace("\\", "/").split("/") if part):
        return 404
    return 0


class Handler(SimpleHTTPRequestHandler):
    def _check(self) -> bool:
        status = allowed(self.headers.get("Host") or "", self.path)
        if status:
            self.send_error(status)
        return not status

    def do_GET(self) -> None:
        if self._check():
            super().do_GET()

    def do_HEAD(self) -> None:
        if self._check():
            super().do_HEAD()

    def list_directory(self, path):  # a folder without index.html is not a page
        self.send_error(404)
        return None


def main() -> None:
    port, folder = int(sys.argv[1]), sys.argv[2]
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=folder))
    print(f"Serving {folder} on Local: http://localhost:{port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
