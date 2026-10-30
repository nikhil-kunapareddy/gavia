"""Write the looncall reference the Rust port is checked against.

Runs loonet's own pipeline (src/detect_loon_calls.py): the `birdnet` package
reads each file, cuts 3 s windows and runs BirdNET 2.4's TFLite model, and the
head in models/looncall/v1/weights.npz turns each embedding into P(loon call).
What birdnet can't read itself goes through ffmpeg to 48 kHz mono first, as
detect_loon_calls.py does.

Output: src-tauri/tests/fixtures/looncall_reference.json, with every window's
start, end and probability for

- `fixtures`: the clips in src-tauri/tests/fixtures/audio, checked in CI by
  tests/calls.rs;
- `recordings`: the looncall val split, by path relative to loonet's
  data/looncall_raw, checked by tests/call_parity.rs when that data is there.

Needs loonet's audio environment and ffmpeg:

    ~/.venvs/loonet-audio/bin/python scripts/looncall_reference.py \
        --loonet ~/Documents/loonet
"""

import argparse
import csv
import hashlib
import json
import os
import subprocess
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "..", "src-tauri", "tests", "fixtures")
NATIVE = {".wav", ".mp3", ".flac", ".ogg"}


def readable(paths, tmp):
    """{path birdnet can read: original path}, converting the rest like loonet does."""
    mapping = {}
    for path in paths:
        if os.path.splitext(path)[1].lower() in NATIVE:
            mapping[os.path.abspath(path)] = path
            continue
        dst = os.path.join(tmp, f"{len(mapping):05d}.wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-vn", "-ac", "1",
                        "-ar", "48000", dst], check=True)
        mapping[dst] = path
    return mapping


def score(model, weights, paths):
    """{original path: [[start_s, end_s, p_loon], ...]} in window order."""
    with tempfile.TemporaryDirectory() as tmp:
        mapping = readable(paths, tmp)
        encoded = model.encode(list(mapping), n_workers=1, batch_size=8).to_structured_array()
    out = {}
    for row in encoded:
        z = ((row["embedding"] - weights["mean"]) / weights["scale"]) @ weights["coef"] \
            + weights["intercept"]
        p = 1 / (1 + np.exp(-z))
        out.setdefault(mapping[str(row["input"])], []).append(
            [round(float(row["start_time"]), 6), round(float(row["end_time"]), 6),
             round(float(p), 6)])
    for windows in out.values():
        windows.sort()
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--loonet", required=True, help="the loonet repo")
    a = ap.parse_args()
    loonet = os.path.expanduser(a.loonet)
    head = os.path.join(loonet, "models", "looncall", "v1", "weights.npz")
    weights = dict(np.load(head))
    with open(head, "rb") as f:
        head_sha = hashlib.sha256(f.read()).hexdigest()

    import birdnet
    model = birdnet.load("acoustic", "2.4", "tf", library="litert")

    clips_dir = os.path.join(FIXTURES, "audio")
    clips = sorted(os.path.join(clips_dir, f) for f in os.listdir(clips_dir)
                   if not f.startswith(".") and not f.endswith(".md"))
    raw = os.path.join(loonet, "data", "looncall_raw")
    with open(os.path.join(loonet, "data", "annotated", "looncall_v1", "val.csv")) as f:
        val = sorted({row["file"] for row in csv.DictReader(f)})

    fixtures = score(model, weights, clips)
    recordings = score(model, weights, [os.path.join(raw, v) for v in val])
    reference = {
        "note": "Written by desktop/scripts/looncall_reference.py; do not edit by hand.",
        "pipeline": f"birdnet {birdnet.__version__ if hasattr(birdnet, '__version__') else '1.3.1'} "
                    "(acoustic 2.4, tf, litert) + looncall v1 head",
        "head_sha256": head_sha,
        "fixtures": {os.path.basename(p): w for p, w in sorted(fixtures.items())},
        "recordings": {os.path.relpath(p, raw): w for p, w in sorted(recordings.items())},
    }
    out = os.path.join(FIXTURES, "looncall_reference.json")
    with open(out, "w") as f:
        json.dump(reference, f, indent=1)
        f.write("\n")
    n = sum(len(w) for w in fixtures.values()) + sum(len(w) for w in recordings.values())
    print(f"wrote {out}: {len(fixtures)} clips, {len(recordings)} recordings, {n} windows")


if __name__ == "__main__":
    main()
