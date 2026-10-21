"""Static server for the landing page behind Cloudflare Tunnel.

http.server's default listen backlog is 5, which drops connections when a browser
opens many asset requests at once (Cloudflare then shows 502). This raises it, uses
threads, and sets cache headers so Cloudflare serves the assets."""
import functools, http.server, os, sys

ROOT = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "dist"))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4175


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def end_headers(self):
        p, _, q = self.path.partition("?")
        if p.startswith("/assets/") and q.startswith("v="):
            # the URL carries a content hash, so it can never go stale
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        elif p.startswith("/assets/"):
            self.send_header("Cache-Control", "public, max-age=3600")
        else:
            self.send_header("Cache-Control", "public, max-age=60")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt, *args):
        if args and str(args[1]) not in ("200", "304"):
            super().log_message(fmt, *args)


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 512
    daemon_threads = True


if __name__ == "__main__":
    Server(("127.0.0.1", PORT), functools.partial(Handler, directory=ROOT)).serve_forever()
