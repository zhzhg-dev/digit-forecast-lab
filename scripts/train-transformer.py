"""Train the Digit Forecast Lab Transformer on self-generated synthetic digits.

Use Python 3.14 and CPU PyTorch 2.14.1. From the repository directory:
    python -m pip install torch==2.14.1+cpu --index-url https://download.pytorch.org/whl/cpu
    python scripts/train-transformer.py

Weights and validation figures can vary slightly with the CPU and PyTorch build.
"""

import argparse
import json
import math
from pathlib import Path

import torch
from torch import nn
from torch.nn import functional as F


CONTEXT = 32
HORIZON = 20
WIDTH = 24
HEADS = 4
HEAD_WIDTH = WIDTH // HEADS
FEED_FORWARD = 32
DIGITS = 10
PAD = DIGITS
TRAIN_SEED = 0x53F00000
VALIDATION_SEED = 0x6A800000
MODEL_SEED = 0x0C710042
KINDS = ("uniform", "biased", "short", "long")
VALIDATION_STREAMS = 4096
OUTPUT = Path(__file__).resolve().parents[1] / "transformer-weights.mjs"


def rms_normalize(x):
    return x * (x.square().mean(dim=-1, keepdim=True) + 1e-5).rsqrt()


class DigitTransformer(nn.Module):
    def __init__(self):
        super().__init__()
        self.digit = nn.Embedding(DIGITS + 1, WIDTH, padding_idx=PAD)
        self.position = nn.Embedding(CONTEXT, WIDTH)
        self.query = nn.Linear(WIDTH, WIDTH, bias=False)
        self.key = nn.Linear(WIDTH, WIDTH, bias=False)
        self.value = nn.Linear(WIDTH, WIDTH, bias=False)
        self.attention_bias = nn.Parameter(torch.zeros(HEADS, CONTEXT))
        self.attention_output = nn.Linear(WIDTH, WIDTH, bias=False)
        self.feed_in = nn.Linear(WIDTH, FEED_FORWARD)
        self.feed_out = nn.Linear(FEED_FORWARD, WIDTH)
        self.readout = nn.Linear(WIDTH, HORIZON * DIGITS)
        nn.init.normal_(self.digit.weight, std=0.25)
        nn.init.normal_(self.position.weight, std=0.10)
        with torch.no_grad():
            self.digit.weight[PAD].zero_()

    def forward(self, history):
        size = history.shape[0]
        positions = torch.arange(CONTEXT)
        tokens = self.digit(history) + self.position(positions)
        last = tokens[:, -1, :]

        # This one-layer decoder reads out only the final query. Every unmasked
        # key precedes that query or is the query's own input position.
        query = self.query(last).reshape(size, HEADS, 1, HEAD_WIDTH)
        keys = self.key(tokens).reshape(size, CONTEXT, HEADS, HEAD_WIDTH).transpose(1, 2)
        values = self.value(tokens).reshape(size, CONTEXT, HEADS, HEAD_WIDTH).transpose(1, 2)
        scores = (query @ keys.transpose(-1, -2)).squeeze(2) / math.sqrt(HEAD_WIDTH)
        scores = (scores + self.attention_bias).masked_fill(history[:, None, :] == PAD, -torch.inf)
        attended = (scores.softmax(dim=-1).unsqueeze(2) @ values).reshape(size, WIDTH)
        hidden = last + self.attention_output(attended)
        hidden = hidden + self.feed_out(self.feed_in(rms_normalize(hidden)).relu())
        return self.readout(rms_normalize(hidden)).reshape(size, HORIZON, DIGITS)


def make_dataset(streams, seed, shorten_history=False):
    generator = torch.Generator().manual_seed(seed)
    kinds = torch.arange(streams) % len(KINDS)
    kinds = kinds[torch.randperm(streams, generator=generator)]
    digits = torch.randint(DIGITS, (streams, CONTEXT + HORIZON), generator=generator)

    # Each row is a fresh trajectory. No train/validation sliding windows overlap.
    biased = kinds == 1
    biased_count = int(biased.sum())
    favored = torch.randint(DIGITS, (biased_count, 1), generator=generator)
    favored_draw = torch.rand(biased_count, CONTEXT + HORIZON, generator=generator) < 0.4
    digits[biased] = torch.where(favored_draw, favored, digits[biased])

    for kind_index, lag in ((2, 1), (3, 5)):
        group = kinds == kind_index
        copied = digits[group]
        repeat = torch.rand(copied.shape, generator=generator) < 0.6
        for index in range(lag, CONTEXT + HORIZON):
            copied[:, index] = torch.where(repeat[:, index], copied[:, index - lag], copied[:, index])
        digits[group] = copied

    history = digits[:, :CONTEXT]
    if shorten_history:
        shortened = torch.rand(streams, generator=generator) < 0.15
        lengths = torch.randint(1, CONTEXT, (streams,), generator=generator)
        lengths = torch.where(shortened, lengths, CONTEXT)
        history = history.masked_fill(torch.arange(CONTEXT) < CONTEXT - lengths[:, None], PAD)
    return history, digits[:, CONTEXT:], kinds


def losses(logits, targets):
    return F.cross_entropy(logits.transpose(1, 2), targets, reduction="none")


@torch.inference_mode()
def validate(model, dataset, batch_size):
    history, targets, kinds = dataset
    logits = torch.cat([model(batch) for batch in history.split(batch_size)])
    hit = (logits.argmax(dim=-1) == targets).float()
    log_loss = losses(logits, targets)
    by_kind = {}
    for kind_index, name in enumerate(KINDS):
        rows = kinds == kind_index
        by_kind[name] = {
            str(step): {
                "accuracy": round(hit[rows, step - 1].mean().item(), 6),
                "logLoss": round(log_loss[rows, step - 1].mean().item(), 6),
            }
            for step in (1, 5, 20)
        }
    return by_kind


def export_weights(model, args, metrics, final_loss):
    def values(tensor):
        return torch.round(tensor.detach().to(torch.float64) * 10_000_000).div(10_000_000).tolist()

    def layer(linear):
        entry = {"weight": values(linear.weight)}
        if linear.bias is not None:
            entry["bias"] = values(linear.bias)
        return entry

    metadata = {
        "contextLength": CONTEXT,
        "maxHorizon": HORIZON,
        "width": WIDTH,
        "attentionHeads": HEADS,
        "feedForwardWidth": FEED_FORWARD,
        "parameterCount": sum(tensor.numel() for tensor in model.parameters()),
        "trainingStreams": args.epochs * args.streams_per_epoch,
        "validationStreams": VALIDATION_STREAMS,
        "trainSeed": TRAIN_SEED,
        "validationSeed": VALIDATION_SEED,
        "epochs": args.epochs,
        "batchSize": args.batch_size,
        "trainingLoss": round(final_loss, 6),
        "validation": metrics,
    }
    weights = {
        "digit": values(model.digit.weight[:DIGITS]),
        "position": values(model.position.weight),
        "query": layer(model.query),
        "key": layer(model.key),
        "value": layer(model.value),
        "attentionBias": values(model.attention_bias),
        "attentionOutput": layer(model.attention_output),
        "feedIn": layer(model.feed_in),
        "feedOut": layer(model.feed_out),
        "readout": layer(model.readout),
    }
    def one_line_per_row(value):
        return json.dumps(value, separators=(",", ":")).replace("],[", "],\n    [")

    lines = [
        "// Generated by scripts/train-transformer.py from synthetic data. Do not edit by hand.",
        "export const TRAINING_METADATA = " + json.dumps(metadata, indent=2) + ";",
        "export const TRANSFORMER_WEIGHTS = {",
        *(f"  {key}: {one_line_per_row(value)}," for key, value in weights.items()),
        "};",
    ]
    args.output.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps(metadata, indent=2), flush=True)


@torch.inference_mode()
def write_probes(model, path):
    histories, _, _ = make_dataset(12, VALIDATION_SEED + 1)
    contexts = [histories[0], histories[1, -7:], histories[2, -1:]]
    probes = []
    for history in contexts:
        padded = F.pad(history, (CONTEXT - len(history), 0), value=PAD)
        probabilities = model(padded.unsqueeze(0))[0].softmax(dim=-1)
        probes.append({"history": history.tolist(), "probabilities": probabilities.tolist()})
    path.write_text(json.dumps(probes), encoding="utf-8", newline="\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--epochs", type=int, default=32)
    parser.add_argument("--streams-per-epoch", type=int, default=8192)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--probe-output", type=Path, help="optional PyTorch parity probes for the JS implementation")
    args = parser.parse_args()
    if args.epochs < 1 or args.streams_per_epoch < 4 or args.batch_size < 1:
        parser.error("epochs and batch size must be positive, with at least four streams per epoch")

    torch.set_num_threads(2)
    torch.use_deterministic_algorithms(True)
    torch.manual_seed(MODEL_SEED)
    model = DigitTransformer()
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.003, weight_decay=0.01)
    schedule = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, args.epochs, eta_min=0.0005)
    step_weights = torch.ones(HORIZON)
    step_weights[[0, 4]] = 3
    step_weights /= step_weights.sum()

    for epoch in range(args.epochs):
        histories, targets, _ = make_dataset(args.streams_per_epoch, TRAIN_SEED + epoch, shorten_history=True)
        total = 0.0
        model.train()
        for history, target in zip(histories.split(args.batch_size), targets.split(args.batch_size)):
            optimizer.zero_grad(set_to_none=True)
            loss = (losses(model(history), target) * step_weights).sum(dim=1).mean()
            loss.backward()
            optimizer.step()
            total += loss.item() * len(history)
        schedule.step()
        final_loss = total / len(histories)
        print(f"epoch {epoch + 1:02d}/{args.epochs:02d}: weighted training log loss {final_loss:.5f}", flush=True)

    model.eval()
    validation = make_dataset(VALIDATION_STREAMS, VALIDATION_SEED)
    export_weights(model, args, validate(model, validation, args.batch_size), final_loss)
    if args.probe_output is not None:
        write_probes(model, args.probe_output)


if __name__ == "__main__":
    main()
