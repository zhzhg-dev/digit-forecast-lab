"""Train the synthetic-only Digit Forecast Lab lag-feature Transformer.

With Python 3.14, from the repository directory:
    python -m pip install torch==2.14.1+cpu --index-url https://download.pytorch.org/whl/cpu
    python scripts/train-transformer.py

CPU and PyTorch build differences can slightly change the exported weights.
"""

import argparse
import json
import math
from pathlib import Path

import torch
from torch import nn
from torch.nn import functional as F


CONTEXT = 1024
HORIZON = 20
MIN_HISTORY = 16
MAX_LAG = 12
MIN_FIT_PAIRS = 4
FIT_FRACTION = 0.65
REPEAT_PRIOR = 6
REPEAT_CAP = 0.995
EVIDENCE_SCALE = 0.6
CORRECTION_LIMIT = 3
DIGITS = 10
TOKEN_WIDTH = 7
WIDTH = 16
HEADS = 2
HEAD_WIDTH = WIDTH // HEADS
FEED_FORWARD = 24
TRAIN_SEED = 0x75E00000
VALIDATION_SEED = 0x2C300000
MODEL_SEED = 0x3A6D1472
TRAIN_LAGS = tuple(lag for lag in range(1, MAX_LAG + 1) if lag != 8)
TRAIN_LENGTHS = (16, 32, 64, 128, 256, 512, 1024)
DEV_STREAMS_PER_SCENARIO = 1024
DEV_SCENARIOS = (
    ("uniform", 0, 0.0, 0.0),
    ("biased", 0, 0.0, 0.4),
    ("copyLag1", 1, 0.6, 0.0),
    ("copyLag5", 5, 0.6, 0.0),
    ("copyLag8", 8, 0.6, 0.0),
    ("copyLag8Skewed", 8, 0.67, 0.25),
    ("exactLag5", 5, 1.0, 0.0),
)
OUTPUT = Path(__file__).resolve().parents[1] / "transformer-weights.mjs"


def rms(x):
    return x * (x.square().mean(dim=-1, keepdim=True) + 1e-5).rsqrt()


class LagTransformer(nn.Module):
    """One shared attention block over the marginal and copy experts' evidence."""

    def __init__(self):
        super().__init__()
        self.embedding = nn.Linear(TOKEN_WIDTH, WIDTH)
        self.query = nn.Linear(WIDTH, WIDTH, bias=False)
        self.key = nn.Linear(WIDTH, WIDTH, bias=False)
        self.value = nn.Linear(WIDTH, WIDTH, bias=False)
        self.attention_output = nn.Linear(WIDTH, WIDTH, bias=False)
        self.feed_in = nn.Linear(WIDTH, FEED_FORWARD)
        self.feed_out = nn.Linear(FEED_FORWARD, WIDTH)
        self.score = nn.Linear(WIDTH, 1)

    def forward(self, evidence, prior_logits):
        tokens = self.embedding(evidence).tanh()
        batch, count, _ = tokens.shape

        def split_heads(values):
            return values.reshape(batch, count, HEADS, HEAD_WIDTH).transpose(1, 2)

        queries = split_heads(self.query(tokens))
        keys = split_heads(self.key(tokens))
        values = split_heads(self.value(tokens))
        attention = (queries @ keys.transpose(-1, -2) / math.sqrt(HEAD_WIDTH)).softmax(dim=-1)
        readout = (attention @ values).transpose(1, 2).reshape(batch, count, WIDTH)
        hidden = rms(tokens + self.attention_output(readout))
        hidden = rms(hidden + self.feed_out(self.feed_in(hidden).relu()))
        correction = CORRECTION_LIMIT * self.score(hidden).squeeze(-1).tanh()
        return (prior_logits + correction).softmax(dim=-1)


def categorical_marginal(history):
    batch, length = history.shape
    counts = torch.ones(batch, DIGITS)
    counts.scatter_add_(1, history, torch.ones_like(history, dtype=torch.float32))
    return counts / (length + DIGITS)


def copy_strength(matches, expected, pairs):
    return ((matches - expected) / (pairs - expected + REPEAT_PRIOR)).clamp(0, REPEAT_CAP)


def evidence_from_history(history):
    batch, length = history.shape
    split = math.floor(length * FIT_FRACTION)
    size = torch.full((batch,), math.log1p(length) / math.log1p(CONTEXT))
    marginal = categorical_marginal(history)
    fit_marginal = categorical_marginal(history[:, :split])
    largest = marginal.max(dim=1).values
    zero = torch.zeros(batch)

    tokens = [torch.stack([torch.ones_like(zero), size, largest, zero, zero, zero, zero], dim=1)]
    priors = [zero]
    strengths = [zero]
    held_out_probability = fit_marginal.gather(1, history[:, split:])

    for lag in range(1, MAX_LAG + 1):
        if split - lag < MIN_FIT_PAIRS:
            tokens.append(torch.stack([zero, size, largest, zero, zero, zero, zero], dim=1))
            priors.append(torch.full_like(zero, -30))
            strengths.append(zero)
            continue

        sources = history[:, :length - lag]
        fit_sources = sources[:, :split - lag]
        validation_sources = sources[:, split - lag:]
        match = sources == history[:, lag:]
        fit_match = match[:, :split - lag].sum(dim=1)
        validation_match = match[:, split - lag:]
        fit = copy_strength(fit_match, fit_marginal.gather(1, fit_sources).sum(dim=1), split - lag)
        validation = copy_strength(
            validation_match.sum(dim=1),
            fit_marginal.gather(1, validation_sources).sum(dim=1),
            length - split,
        )
        full = copy_strength(match.sum(dim=1), marginal.gather(1, sources).sum(dim=1), length - lag)

        gains = torch.where(
            validation_match,
            torch.log1p(fit[:, None] * (held_out_probability.reciprocal() - 1)),
            torch.log1p(-fit[:, None]),
        ).sum(dim=1)
        tokens.append(torch.stack([zero, size, largest, fit, full, validation, gains / (length - split)], dim=1))
        priors.append(EVIDENCE_SCALE * gains - math.log(MAX_LAG))
        strengths.append(full)
    return torch.stack(tokens, dim=1), torch.stack(priors, dim=1), marginal, torch.stack(strengths, dim=1)


def expert_forecasts(history, marginal, strengths, targets=None):
    # When targets are supplied, compute only the probabilities needed for
    # training loss. Neither the evidence nor the weights see these targets.
    horizon = torch.arange(HORIZON)
    if targets is None:
        baseline = marginal[:, None, :].expand(-1, HORIZON, -1)
    else:
        baseline = marginal.gather(1, targets)
    candidates = [baseline]
    for lag in range(1, MAX_LAG + 1):
        initial = history[:, history.shape[1] - lag + horizon % lag]
        copies = strengths[:, lag, None] ** (horizon // lag + 1)
        if targets is None:
            candidate = (1 - copies[:, :, None]) * baseline + copies[:, :, None] * F.one_hot(initial, DIGITS)
        else:
            candidate = (1 - copies) * baseline + copies * (initial == targets)
        candidates.append(candidate)
    return torch.stack(candidates, dim=1)


def with_bias(digits, force_probability, generator):
    favored = torch.randint(DIGITS, (len(digits), 1), generator=generator)
    force = torch.rand(digits.shape, generator=generator) < force_probability[:, None]
    return torch.where(force, favored, digits)


def with_copy(digits, lag, repeat_probability, generator):
    # Each residue class is a separate strand. A copy takes the most recent
    # fresh digit on that strand, so independent trajectories can be batched.
    batch, length = digits.shape
    strands = F.pad(digits, (0, -length % lag)).reshape(batch, -1, lag)
    copy = torch.rand(strands.shape, generator=generator) < repeat_probability[:, None, None]
    step = torch.arange(strands.shape[1])[None, :, None]
    latest_fresh = torch.where(copy, 0, step).cummax(dim=1).values
    return strands.gather(1, latest_fresh).reshape(batch, -1)[:, :length]


def make_batch(streams, history_length, generator, scenario=None):
    digits = torch.randint(DIGITS, (streams, history_length + HORIZON), generator=generator)
    if scenario is None:
        kinds = (torch.arange(streams) % 4)[torch.randperm(streams, generator=generator)]
        biased = kinds == 1
        bias_strengths = torch.tensor([0.25, 0.4, 0.55])
        biases = bias_strengths[torch.randint(len(bias_strengths), (streams,), generator=generator)]
        digits[biased] = with_bias(digits[biased], biases[biased], generator)

        lags = torch.tensor(TRAIN_LAGS)[torch.randint(len(TRAIN_LAGS), (streams,), generator=generator)]
        noise_strengths = torch.tensor([0.35, 0.5, 0.6, 0.75, 0.9])
        repeats = noise_strengths[torch.randint(len(noise_strengths), (streams,), generator=generator)]
        repeats = torch.where(kinds == 3, 1, repeats)
        for lag in TRAIN_LAGS:
            group = (kinds >= 2) & (lags == lag)
            if group.any():
                digits[group] = with_copy(digits[group], lag, repeats[group], generator)
    else:
        _, lag, repeat, bias = scenario
        if bias:
            digits = with_bias(digits, torch.full((streams,), bias), generator)
        if lag:
            digits = with_copy(digits, lag, torch.full((streams,), repeat), generator)
    return digits[:, :history_length], digits[:, history_length:]


def mixture_forecast(weights, experts):
    return (weights[:, :, None, None] * experts).sum(dim=1)


@torch.inference_mode()
def validate(model, batch_size):
    scenarios = {}
    for index, scenario in enumerate(DEV_SCENARIOS):
        generator = torch.Generator().manual_seed(VALIDATION_SEED + index)
        history, target = make_batch(DEV_STREAMS_PER_SCENARIO, CONTEXT, generator, scenario)
        forecasts = []
        prior_forecasts = []
        for batch in history.split(batch_size):
            tokens, priors, marginal, strengths = evidence_from_history(batch)
            experts = expert_forecasts(batch, marginal, strengths)
            forecasts.append(mixture_forecast(model(tokens, priors), experts))
            prior_forecasts.append(mixture_forecast(priors.softmax(dim=1), experts))
        probabilities = torch.cat(forecasts)
        prior_probabilities = torch.cat(prior_forecasts)
        hit = probabilities.argmax(dim=-1) == target
        log_loss = -probabilities.gather(-1, target[:, :, None]).squeeze(-1).log()
        prior_loss = -prior_probabilities.gather(-1, target[:, :, None]).squeeze(-1).log()
        scenarios[scenario[0]] = {
            str(step): {
                "accuracy": round(hit[:, step - 1].float().mean().item(), 6),
                "logLoss": round(log_loss[:, step - 1].mean().item(), 6),
                "priorLogLoss": round(prior_loss[:, step - 1].mean().item(), 6),
            }
            for step in (1, 5)
        }
        scenarios[scenario[0]]["fullMatch5"] = round(hit[:, :5].all(dim=1).float().mean().item(), 6)
    return scenarios


def export_weights(model, args, metrics, final_loss):
    def values(tensor):
        return torch.round(tensor.detach().to(torch.float64) * 10_000_000).div(10_000_000).tolist()

    def layer(linear):
        entry = {"weight": values(linear.weight)}
        if linear.bias is not None:
            entry["bias"] = values(linear.bias)
        return entry

    metadata = {
        "modelType": "lag-feature-transformer-mixture",
        "contextLength": CONTEXT,
        "maxHorizon": HORIZON,
        "minimumHistory": MIN_HISTORY,
        "maxLag": MAX_LAG,
        "minFitPairs": MIN_FIT_PAIRS,
        "fitFraction": FIT_FRACTION,
        "repeatPrior": REPEAT_PRIOR,
        "repeatCap": REPEAT_CAP,
        "evidenceScale": EVIDENCE_SCALE,
        "correctionLimit": CORRECTION_LIMIT,
        "width": WIDTH,
        "attentionHeads": HEADS,
        "feedForwardWidth": FEED_FORWARD,
        "parameterCount": sum(tensor.numel() for tensor in model.parameters()),
        "trainLags": list(TRAIN_LAGS),
        "trainHistoryLengths": list(TRAIN_LENGTHS),
        "trainingStreams": args.epochs * args.streams_per_epoch,
        "validationStreams": len(DEV_SCENARIOS) * DEV_STREAMS_PER_SCENARIO,
        "trainSeed": TRAIN_SEED,
        "validationSeed": VALIDATION_SEED,
        "epochs": args.epochs,
        "batchSize": args.batch_size,
        "trainingLoss": round(final_loss, 6),
        "validation": metrics,
    }
    weights = {
        "embedding": layer(model.embedding),
        "query": layer(model.query),
        "key": layer(model.key),
        "value": layer(model.value),
        "attentionOutput": layer(model.attention_output),
        "feedIn": layer(model.feed_in),
        "feedOut": layer(model.feed_out),
        "score": layer(model.score),
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
    generator = torch.Generator().manual_seed(VALIDATION_SEED + 32)
    probes = []
    for length, scenario in ((CONTEXT, DEV_SCENARIOS[4]), (31, DEV_SCENARIOS[2]), (1, DEV_SCENARIOS[0])):
        history, _ = make_batch(1, length, generator, scenario)
        if length < MIN_HISTORY:
            probabilities = categorical_marginal(history)[:, None, :].expand(-1, HORIZON, -1)
        else:
            tokens, priors, marginal, strengths = evidence_from_history(history)
            probabilities = mixture_forecast(model(tokens, priors), expert_forecasts(history, marginal, strengths))
        probes.append({"history": history[0].tolist(), "probabilities": probabilities[0].tolist()})
    path.write_text(json.dumps(probes), encoding="utf-8", newline="\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--epochs", type=int, default=16)
    parser.add_argument("--streams-per-epoch", type=int, default=4096)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--probe-output", type=Path, help="optional PyTorch parity probes for the JS implementation")
    args = parser.parse_args()
    if args.epochs < 1 or args.streams_per_epoch < 4 or args.batch_size < 4:
        parser.error("epochs must be positive and streams per epoch and batch size must be at least four")

    torch.set_num_threads(2)
    torch.use_deterministic_algorithms(True)
    torch.manual_seed(MODEL_SEED)
    model = LagTransformer()
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.003, weight_decay=0.01)
    schedule = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, args.epochs, eta_min=0.0005)
    step_weights = torch.ones(HORIZON)
    step_weights[[0, 4]] = 3
    step_weights /= step_weights.sum()

    for epoch in range(args.epochs):
        generator = torch.Generator().manual_seed(TRAIN_SEED + epoch)
        total = 0.0
        model.train()
        for batch_index, start in enumerate(range(0, args.streams_per_epoch, args.batch_size)):
            count = min(args.batch_size, args.streams_per_epoch - start)
            length = TRAIN_LENGTHS[(epoch + batch_index) % len(TRAIN_LENGTHS)]
            history, targets = make_batch(count, length, generator)
            tokens, priors, marginal, strengths = evidence_from_history(history)
            experts = expert_forecasts(history, marginal, strengths, targets)
            optimizer.zero_grad(set_to_none=True)
            probabilities = (model(tokens, priors)[:, :, None] * experts).sum(dim=1)
            loss = -(probabilities.log() * step_weights).sum(dim=1).mean()
            loss.backward()
            optimizer.step()
            total += loss.item() * count
        schedule.step()
        final_loss = total / args.streams_per_epoch
        print(f"epoch {epoch + 1:02d}/{args.epochs:02d}: weighted training log loss {final_loss:.5f}", flush=True)

    model.eval()
    export_weights(model, args, validate(model, args.batch_size), final_loss)
    if args.probe_output is not None:
        write_probes(model, args.probe_output)


if __name__ == "__main__":
    main()
