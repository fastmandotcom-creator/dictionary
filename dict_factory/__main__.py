from __future__ import annotations

import argparse

from dict_factory.compile_runtime import compile_runtime, sync_frontend
from dict_factory.config import SYLLABUS_PATH
from dict_factory.generate_expressions import generate_expressions
from dict_factory.generate_syllabus import generate_syllabus
from dict_factory.load_warehouse import load_bundles, load_warehouse
from dict_factory.syllabus import load_syllabus_jsonl


def main() -> None:
    parser = argparse.ArgumentParser(prog="dict_factory")
    sub = parser.add_subparsers(dest="cmd", required=True)
    syllabus = sub.add_parser("syllabus")
    syllabus.add_argument("--target", type=int, default=12000)
    syllabus.add_argument("--batch-size", type=int, default=120)
    expr = sub.add_parser("expressions")
    expr.add_argument("--batch-size", type=int, default=40)
    expr.add_argument("--workers", type=int, default=8)
    sub.add_parser("warehouse")
    compile_cmd = sub.add_parser("compile")
    compile_cmd.add_argument("--sync-frontend", action="store_true")
    web_cmd = sub.add_parser("web")
    web_cmd.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if args.cmd == "syllabus":
        generate_syllabus(target=args.target, batch_size=args.batch_size)
    elif args.cmd == "expressions":
        generate_expressions(batch_size=args.batch_size, workers=args.workers)
    elif args.cmd == "warehouse":
        load_warehouse()
    elif args.cmd == "compile":
        concepts = load_syllabus_jsonl(SYLLABUS_PATH.read_text(encoding="utf-8"))
        bundles = load_bundles()
        compile_runtime(concepts, bundles)
        if args.sync_frontend:
            sync_frontend()
    elif args.cmd == "web":
        import uvicorn
        from dict_factory.web_server import app
        uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
