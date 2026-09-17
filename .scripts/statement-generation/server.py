"""Serve the statement explorer and discover model CSVs under data/."""
import argparse
import csv
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent


def discover_models():
    models = []
    for path in sorted((ROOT / "data").glob("*/statements.csv")):
        if not path.stat().st_size:
            continue
        with path.open(newline="", encoding="utf-8") as handle:
            row = next(csv.DictReader(handle), None)
        if row is not None:
            evaluations = []
            for evaluation_path in sorted(
                path.parent.glob("evaluations/*/statements.csv")
            ):
                if not evaluation_path.stat().st_size:
                    continue
                with evaluation_path.open(newline="", encoding="utf-8") as handle:
                    evaluation_row = next(csv.DictReader(handle), None)
                if evaluation_row is not None:
                    stored_name = evaluation_path.parent.name.replace("--", "/")
                    judge_name = evaluation_row.get("judge_model") or stored_name
                    if stored_name.endswith(":batch") and not judge_name.endswith(":batch"):
                        judge_name += ":batch"
                    evaluations.append({
                        "name": judge_name,
                        "path": evaluation_path.relative_to(ROOT).as_posix(),
                    })
            models.append({
                "name": row.get("model") or path.parent.name.replace("--", "/"),
                "path": path.relative_to(ROOT).as_posix(),
                "evaluations": evaluations,
            })
    return models


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _send_json(self, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == "/api/models":
            self._send_json(discover_models())
            return
        # Never serve dotfiles such as the API-key .env file.
        from urllib.parse import unquote
        if any(part.startswith(".") for part in unquote(parsed.path).split("/") if part):
            self.send_error(404)
            return
        super().do_GET()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Statement Explorer: http://localhost:{args.port}", flush=True)
    server.serve_forever()
