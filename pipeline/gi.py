"""Thin CLI between the Electron main process and Modal. Every command prints one JSON line.

  uvx --from modal==1.5.5 python pipeline/gi.py spawn-views <listingId> <progressKey>
  uvx --from modal==1.5.5 python pipeline/gi.py spawn-splat <job> <posedPath> <progressKey> <expectedFrames> [A10G|H100] [iterations] [scaleReg 0|1]
  uvx --from modal==1.5.5 python pipeline/gi.py status <callId> <progressKey>
  uvx --from modal==1.5.5 python pipeline/gi.py check
"""
import json
import sys

import modal


def main(argv: list[str]) -> dict:
    cmd, args = argv[0], argv[1:]
    if cmd == "spawn-views":
        listing_id, key = args
        call = modal.Function.from_name("garage-intelligence-novel-view", "generate_views").spawn(listing_id, key)
        return {"callId": call.object_id}
    if cmd == "spawn-splat":
        job, posed, key, expected, *rest = args
        fn = "reconstruct_fast" if (rest[0] if rest else "A10G").upper() == "H100" else "reconstruct"
        iterations = int(rest[1]) if len(rest) > 1 else 15000
        scale_reg = len(rest) > 2 and rest[2] == "1"
        call = modal.Function.from_name("garage-intelligence-splat", fn).spawn(job, None, False, iterations, "sift", posed, key, int(expected), scale_reg)
        return {"callId": call.object_id}
    if cmd == "status":
        call_id, key = args
        prog = modal.Dict.from_name("gi-progress", create_if_missing=True).get(key)
        out: dict = {"progress": json.loads(prog) if prog else None}
        try:
            out["result"] = modal.FunctionCall.from_id(call_id).get(timeout=0)
            out["state"] = "done"
        except TimeoutError:
            out["state"] = "running"
        except Exception as e:  # remote exception, cancellation, expired call
            out["state"], out["error"] = "failed", f"{type(e).__name__}: {str(e)[:300]}"
        return out
    if cmd == "check":
        return {"seva": modal.Function.from_name("garage-intelligence-novel-view", "check_access").remote()}
    raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1:])))
