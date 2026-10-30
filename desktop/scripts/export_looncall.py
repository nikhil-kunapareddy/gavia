"""Export looncall as one ONNX file the Rust core can run.

looncall (in the loonet repo, models/looncall/v1) is a logistic regression on
BirdNET 2.4's 1024-d embeddings. Gavia runs ONNX, not TFLite, so this converts
BirdNET's FP32 TFLite model with tf2onnx, keeps it up to the embedding, and
appends the head, giving one graph from audio to P(loon call):

    audio (batch, 144000) float32, 3 s at 48 kHz  ->  p_loon (batch,)

Two changes to BirdNET on the way, neither of which alters what it computes:

- Its spectrogram layer takes an RFFT and casts the complex result to float,
  which keeps the real part. tf2onnx can't convert that RFFT, so it becomes a
  MatMul with the real-DFT (cosine) matrix, which is the same real part.
- That MatMul feeds straight into the mel filterbank MatMul, so the two
  matrices are multiplied once here and the filterbank MatMul is dropped. It
  cuts the front end from ~2.7 to ~0.2 GFLOP per window.

The classifier for BirdNET's 6522 species is cut off, which halves the file.

The result is checked against the TFLite model on real recordings before
anything is written, and the .json beside it records where it came from.

Needs its own environment (tf2onnx stops at TensorFlow 2.15 and numpy 1):

    uv venv /tmp/looncall-export --python 3.11
    uv pip install --python /tmp/looncall-export/bin/python \
        tensorflow==2.15.1 tf2onnx==1.16.1 onnx==1.16.2 onnxruntime "numpy<2" "protobuf<4"
    /tmp/looncall-export/bin/python scripts/export_looncall.py \
        --tflite "~/Library/Application Support/birdnet/acoustic-models/v2.4/tf/model-fp32.tflite" \
        --head ~/Documents/loonet/models/looncall/v1 \
        --check ~/Documents/loonet/data/looncall_raw/loon/*.mp3

The TFLite file is the one the `birdnet` package downloads on first use (from
https://zenodo.org/records/15050749). Decoding --check files needs ffmpeg.
"""

import argparse
import datetime
import hashlib
import json
import os
import subprocess
import sys

import numpy as np
import onnx
import onnxruntime as ort
import tensorflow as tf
import tf2onnx
from onnx import TensorProto, helper, numpy_helper
from tf2onnx import utils

SAMPLE_RATE = 48000
WINDOW = 3 * SAMPLE_RATE
# Pooled 1024-d features; tf2onnx follows it with a Squeeze whose name varies.
POOL = "model/GLOBAL_AVG_POOL/Mean"
# Indices into BirdNET 2.4's FP32 TFLite model, as the birdnet package uses them.
TFLITE_EMBEDDING, TFLITE_INPUT = 545, 0
# The largest P(loon) difference from TFLite that still counts as the same model.
TOLERANCE = 1e-3

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "src-tauri", "resources", "calls")


def real_dft(ctx, node, name, args):
    """tf2onnx handler: RFFT2D, whose only use is a cast to its real part, as
    a MatMul with the cosine matrix."""
    length = int(node.inputs[1].get_tensor_value()[-1])
    n = np.arange(length)[:, None]
    k = np.arange(length // 2 + 1)[None, :]
    # (n * k) % length keeps the argument small, so the cosines stay exact.
    cosines = np.cos(2 * np.pi * ((n * k) % length) / length)
    const = ctx.make_const(utils.make_name(node.name + "/real_dft"), cosines.astype(np.float32))
    node.type = "MatMul"
    ctx.replace_inputs(node, [node.input[0], const.output[0]])
    ctx.set_dtype(node.output[0], TensorProto.FLOAT)
    for squeeze in ctx.find_output_consumers(node.output[0]):
        ctx.set_dtype(squeeze.output[0], TensorProto.FLOAT)


def fold_filterbanks(graph):
    """Multiply each real-DFT matrix into the mel filterbank that follows it.

    Between the two MatMuls there is only a squeeze, a no-op cast and a
    reshape to (frames, bins), so the filterbank MatMul can become an Identity
    once its matrix is folded in and the reshape asks for mel bins instead."""
    inits = {i.name: i for i in graph.initializer}
    producers = {o: n for n in graph.node for o in n.output}
    folded = 0
    for layer in ("MEL_SPEC1", "MEL_SPEC2"):
        prefix = f"model/{layer}/"
        matmuls = [n for n in graph.node if n.op_type == "MatMul" and n.name.startswith(prefix)]
        dft = [n for n in matmuls if "/stft/" in n.name]
        mel = [n for n in matmuls if "/Tensordot/" in n.name]
        if len(dft) != 1 or len(mel) != 1:
            sys.exit(f"{layer}: expected one DFT and one filterbank MatMul, found {len(dft)} and {len(mel)}")
        dft_init, mel_init = inits[dft[0].input[1]], inits[mel[0].input[1]]
        cosines = numpy_helper.to_array(dft_init).astype(np.float64)
        filterbank = numpy_helper.to_array(mel_init).astype(np.float64)
        dft_init.CopyFrom(numpy_helper.from_array((cosines @ filterbank).astype(np.float32), dft_init.name))
        reshape = producers.get(mel[0].input[0])
        if reshape is None or reshape.op_type != "Reshape" or reshape.input[1] not in inits:
            sys.exit(f"{layer}: expected a constant Reshape before the filterbank")
        shape_init = inits[reshape.input[1]]
        shape = numpy_helper.to_array(shape_init).copy()
        if shape[-1] != filterbank.shape[0]:
            sys.exit(f"{layer}: the Reshape before the filterbank asks for {shape.tolist()}")
        shape[-1] = filterbank.shape[1]
        # A fresh initializer, in case the old shape is shared with another node.
        new_shape = numpy_helper.from_array(shape, f"{reshape.name}/mel_shape")
        graph.initializer.append(new_shape)
        reshape.input[1] = new_shape.name
        identity = helper.make_node("Identity", [mel[0].input[0]], list(mel[0].output), name=mel[0].name)
        # In place: nodes must stay topologically sorted.
        index = list(graph.node).index(mel[0])
        graph.node.remove(mel[0])
        graph.node.insert(index, identity)
        folded += 1
    return folded


def embedding_tensor(graph):
    squeezes = [n for n in graph.node if n.op_type == "Squeeze" and n.input[0] == POOL]
    if len(squeezes) != 1:
        sys.exit(f"expected one Squeeze after {POOL}, found {len(squeezes)}")
    return squeezes[0].output[0]


def append_head(model, weights):
    """p = sigmoid(((embedding - mean) / scale) . coef + intercept), as nodes."""
    graph = model.graph
    embedding = embedding_tensor(graph)
    consts = {
        "head/mean": weights["mean"].astype(np.float32),
        "head/scale": weights["scale"].astype(np.float32),
        "head/coef": weights["coef"].astype(np.float32).reshape(-1, 1),
        "head/intercept": np.asarray(weights["intercept"], np.float32).reshape(1),
        "head/flat": np.asarray([-1], np.int64),
    }
    for name, value in consts.items():
        graph.initializer.append(numpy_helper.from_array(value, name))
    graph.node.extend([
        helper.make_node("Sub", [embedding, "head/mean"], ["head/centred"], name="head/Sub"),
        helper.make_node("Div", ["head/centred", "head/scale"], ["head/scaled"], name="head/Div"),
        helper.make_node("MatMul", ["head/scaled", "head/coef"], ["head/dot"], name="head/MatMul"),
        helper.make_node("Add", ["head/dot", "head/intercept"], ["head/logit"], name="head/Add"),
        helper.make_node("Sigmoid", ["head/logit"], ["head/p"], name="head/Sigmoid"),
        helper.make_node("Reshape", ["head/p", "head/flat"], ["p_loon"], name="head/Reshape"),
    ])
    graph.output.append(helper.make_tensor_value_info("p_loon", TensorProto.FLOAT, ["batch"]))


def rename_input(model, new):
    graph = model.graph
    old = graph.input[0].name
    for node in graph.node:
        node.input[:] = [new if i == old else i for i in node.input]
    graph.input[0].name = new
    graph.input[0].type.tensor_type.shape.dim[0].dim_param = "batch"


def windows(path):
    """Whole 3 s windows of a recording, decoded to 48 kHz mono by ffmpeg."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-"],
        capture_output=True, check=True,
    ).stdout
    audio = np.frombuffer(raw, np.float32)
    return [audio[i:i + WINDOW] for i in range(0, len(audio) - WINDOW + 1, WINDOW)]


def reference(tflite_path, weights, batch):
    """P(loon) the way loonet computes it: TFLite embeddings, head in NumPy."""
    interpreter = tf.lite.Interpreter(
        model_path=tflite_path,
        experimental_op_resolver_type=tf.lite.experimental.OpResolverType.BUILTIN_WITHOUT_DEFAULT_DELEGATES,
        experimental_preserve_all_tensors=True,
    )
    interpreter.allocate_tensors()
    out = []
    for window in batch:
        interpreter.set_tensor(TFLITE_INPUT, window[None])
        interpreter.invoke()
        embedding = interpreter.get_tensor(TFLITE_EMBEDDING)[0]
        z = ((embedding - weights["mean"]) / weights["scale"]) @ weights["coef"] + weights["intercept"]
        out.append(1 / (1 + np.exp(-z)))
    return np.array(out)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--tflite", required=True, help="BirdNET 2.4 FP32 .tflite")
    ap.add_argument("--head", required=True, help="looncall folder holding weights.npz")
    ap.add_argument("--check", nargs="+", required=True, help="recordings to compare against TFLite")
    ap.add_argument("--name", default="looncall_v1")
    ap.add_argument("--out-dir", default=OUT_DIR)
    a = ap.parse_args()
    tflite_path = os.path.expanduser(a.tflite)
    head_dir = os.path.expanduser(a.head)
    weights = dict(np.load(os.path.join(head_dir, "weights.npz")))

    model, _ = tf2onnx.convert.from_tflite(
        tflite_path, opset=17, custom_op_handlers={"RFFT2D": (real_dft, [])}
    )
    print(f"folded {fold_filterbanks(model.graph)} filterbanks into their DFTs")
    rename_input(model, "audio")
    append_head(model, weights)
    model = onnx.utils.Extractor(model).extract_model(["audio"], ["p_loon"])
    model.producer_name, model.producer_version = "tf2onnx", tf2onnx.__version__
    onnx.checker.check_model(model, full_check=True)

    batch = [w for path in a.check for w in windows(os.path.expanduser(path))]
    if not batch:
        sys.exit("--check gave no whole 3 s windows")
    session = ort.InferenceSession(model.SerializeToString(), providers=["CPUExecutionProvider"])
    got = session.run(["p_loon"], {"audio": np.stack(batch)})[0]
    want = reference(tflite_path, weights, batch)
    worst = float(np.abs(got - want).max())
    print(f"{len(batch)} windows: worst |P(loon) - TFLite| = {worst:.2e}; "
          f"{int((want >= 0.5).sum())} loon windows by TFLite, {int((got >= 0.5).sum())} by ONNX")
    if worst > TOLERANCE or ((got >= 0.5) != (want >= 0.5)).any():
        sys.exit(f"the export does not match TFLite (tolerance {TOLERANCE})")

    os.makedirs(a.out_dir, exist_ok=True)
    onnx_path = os.path.join(a.out_dir, f"{a.name}.onnx")
    onnx.save(model, onnx_path)
    metrics_path = os.path.join(head_dir, "..", "..", "..", "runs", "looncall_v1", "metrics.json")
    metrics = {}
    if os.path.exists(metrics_path):
        with open(metrics_path) as f:
            run = json.load(f)
        val = run["looncall v1"]
        noisy = {str(r["snr_db"]): r["looncall_recall"] for r in run["drone_noise"]}
        metrics = {
            "note": "loonet runs/looncall_v1: the clean val split (65 windows), and recall "
                    "with the val windows mixed into drone propeller noise at 5 dB SNR.",
            "precision": val["precision"],
            "recall": val["recall"],
            "average_precision": val["average_precision"],
            "recall_5db_drone_noise": noisy.get("5"),
        }
    meta = {
        "name": "looncall 1.0",
        "description": "Hears Common Loon calls: BirdNET 2.4 embeddings and a logistic "
                       "regression, one answer per 3-second window.",
        "architecture": "BirdNET 2.4 + logistic regression",
        "task": "audio-classify",
        "classes": ["no loon", "common loon"],
        "display_label": "Loon call",
        "file": f"{a.name}.onnx",
        "sha256": sha256(onnx_path),
        "size_bytes": os.path.getsize(onnx_path),
        "input": {"name": "audio", "shape": ["batch", WINDOW], "dtype": "float32",
                  "sample_rate": SAMPLE_RATE, "window_seconds": WINDOW / SAMPLE_RATE},
        "output": {"name": "p_loon", "shape": ["batch"], "meaning": "P(loon call) per window"},
        "defaults": {"threshold": float(weights["threshold"])},
        "export": {
            "opset": 17,
            "exporter": f"tf2onnx {tf2onnx.__version__} + desktop/scripts/export_looncall.py",
            "checked_windows": len(batch),
            "worst_difference_from_tflite": round(worst, 6),
            "exported_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        },
        "provenance": {
            "source_repo": "loonet",
            "head": "models/looncall/v1/weights.npz",
            "head_sha256": sha256(os.path.join(head_dir, "weights.npz")),
            "embedding_model": "BirdNET 2.4 FP32 TFLite (birdnet 1.3.1)",
            "embedding_model_sha256": sha256(tflite_path),
            "embedding_model_url": "https://zenodo.org/records/15050749",
        },
        "metrics": metrics,
        "license": {
            "spdx": "CC-BY-NC-SA-4.0",
            "reason": "Contains BirdNET 2.4, licensed CC BY-NC-SA 4.0 by the K. Lisa Yang "
                      "Center for Conservation Bioacoustics. The looncall head is MIT.",
            "url": "https://creativecommons.org/licenses/by-nc-sa/4.0/",
        },
    }
    with open(os.path.join(a.out_dir, f"{a.name}.json"), "w") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")
    print(f"wrote {onnx_path} ({meta['size_bytes'] / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
