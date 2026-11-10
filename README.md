# Digit Forecast Lab · 数列预测实验室

Compare six methods for forecasting the next digit or the next five digits in a sequence of `0–9`. Try a synthetic example or paste your own sequence, then run a blind backtest and export summary scores or per-window forecasts as CSV. All calculations stay in your browser.

**[Open the app · 打开在线应用](https://zhzhg-dev.github.io/digit-forecast-lab/)**

The app opens in English. Choose **简体中文** in the header to switch languages while keeping your input and results.

The [independent synthetic benchmark](https://zhzhg-dev.github.io/digit-forecast-lab/benchmark.html) compares accuracy and log loss on 400 sequences per process at three history lengths. The lag-aware Transformer uses at most the latest 1,024 digits and fixed attention weights trained on separate synthetic examples. The benchmark includes an unseen eight-position dependency.

The [per-method acceptance report](https://zhzhg-dev.github.io/digit-forecast-lab/acceptance.html) records every gate and outcome. It scores deterministic cases by exact match and stochastic cases against the rule-aware reference on the same held-out sequences.

The [long-history accuracy audit](https://zhzhg-dev.github.io/digit-forecast-lab/high-precision.html) separates published findings from our synthetic controls. It covers exact decimal repetitions, noisy copying and uniform draws, with histories up to 16,384 digits. Verified cycle needs two full cycles for fitting and a separate full cycle for historical validation.

The [Integer Sequence Lab](./integer-lab.html) preserves each integer as one observation. Paste up to 20,000 unsigned 64-bit values separated by commas or whitespace. Run a one- or five-value forecast using only the prefix, then enter the held-out values to score exact integer matches. It compares frequency, a first-order transition validated on the last third of the visible history, and a verified exact cycle. The latter two methods can abstain. Run `npm run integer-benchmark` for an independent synthetic comparison that reports coverage and accuracy separately.

给定一段按时间排序的 `0–9` 序列，比较六种方法对下一位或未来五位的预测。可以试用内置合成数据，也可以粘贴自己的实验序列。输入和计算都留在浏览器里。

应用默认显示英文。可在页眉切换至**简体中文**，已输入的数字和计算结果会保留。

## 使用

1. 选择一个合成样本，或粘贴数字。连续数字、逗号和空白分隔都可以，前导零会保留。
2. 选择预测距离，查看各方法给 `0–9` 分配的概率。
3. 要评估成绩，在回测中提供完整序列并设置每次可见的历史长度。每轮固定一段可见历史，先提交该轮各位置的预测，再计分。后续轮次才可使用已经经过的真实数字。
4. 按预测距离查看命中率、相对平滑频率的百分点变化和对数损失。汇总 CSV 导出每种方法的成绩，明细 CSV 导出每轮的序列位置、预测、真值和十个数字的概率。序列位置从 0 开始，预测步数从 1 开始。

## 方法和实验

| 方法 | 使用的信息 |
| --- | --- |
| 均匀基线 | 给每个数字 10% 的概率 |
| 平滑频率 | 可见历史中的数字频率 |
| 一阶马尔可夫 | 历史中上一位与下一位的转移 |
| 滞后混合（MTD） | 按权重结合平滑频率与 1–12 位之前的转移概率 |
| 滞后特征 Transformer | 最多读取最近 1,024 位，用合成数据训练的注意力模块为频率和滞后预测加权 |
| 周期续写 | 前段至少两轮发现精确周期，后段至少一轮核验。未通过时使用平滑频率 |

内置样本覆盖独立均匀、独立有偏、相隔一位和相隔五位的依赖。两种依赖样本以 60% 的概率复制指定历史位置，其余时候从十个数字中重新均匀抽取。模型只看到数字历史。命中率按预测位置计算，对数损失用自然对数，越低越好。展示的多步概率是各位置的边际概率。

界面回测用于探索单条序列。命令行基准从多条独立合成序列各取一个固定切点，用同一批历史和目标比较各方法。合成基准的结果适用于这些设定。单条输入的预测概率来自模型，是否适用于该序列要结合盲测判断。

[`独立合成基准`](https://zhzhg-dev.github.io/digit-forecast-lab/benchmark.html?lang=zh) 使用 32、128、512 位历史，分别评估下一位和提前预测第 5 位。每类使用 400 条独立初始化的合成序列，并加入模型训练时未见的八位依赖机制。配对区间以每条序列相对平滑频率的命中差值为单位。统计模型从各条可见历史估计参数，Transformer 另有合成预训练数据，因此同时报告其有效上下文和训练方式。

[`长历史精度验证`](https://zhzhg-dev.github.io/digit-forecast-lab/high-precision.html?lang=zh) 逐项对照论文条件，并公开本项目的合成实验结果。测试历史最长 16,384 位。周期为 P 的精确重复至少需要 3×P 位供发现和验证，实际还需历史通过一致性检查。报告按下一位、第 5 位和五位全中分别计分，公开 95% Wilson 区间及首次达到 99% 的测试长度。

[`六种方法逐项验收`](https://zhzhg-dev.github.io/digit-forecast-lab/acceptance.html?lang=zh) 公布每项条件、门槛与实测结果。确定性测试要求整段全中。随机测试对同一批留出序列比较已知规则参照、命中率差值和对数损失差值。

[`整值序列实验室`](./integer-lab.html?lang=zh) 把每个整数作为一次观测。支持用逗号或空白分隔最多 20,000 个无符号 64 位整数。先用历史预测未来一个或五个整值，再输入留出的真值按整值计分。工作台比较频率基线、一阶转移和周期验证法。一阶转移用历史前段拟合，在最后三分之一与频率基线比较。转移和周期方法在证据不足时会弃权。运行 `npm run integer-benchmark` 可查看独立合成序列上的覆盖率和命中率。

### What transfers from the papers · 论文条件如何对照

The ICML LCG experiments train on many sequences from a defined family and score whole generator outputs. Their analysis finds that the input representation and the history available to attention affect which structure the model can learn. The ICLR PCG experiments also use trained models and explicit generator settings. In the one-bit truncation case, 95% refers to the next observed bit at position 256. The Integer Sequence Lab matches the unit of observation for whole-value evaluation. Its benchmark measures generic methods on synthetic controls. [ICML 2025 §4–5](https://arxiv.org/html/2502.10390#S4) · [ICLR 2026 §3–4](https://arxiv.org/html/2510.26792v2#S3)

ICML 的 LCG 实验在同一生成器族的许多序列上训练，并按完整输出计分。论文分析显示，输入编码和注意力能看到的历史会影响模型可利用的结构。ICLR 的 PCG 实验也明确指定了生成器和训练方案。其中 95% 对应截断实验的第 256 个可见比特。整值工作台对齐了完整输出的观测和评分单位，基准结果来自对通用方法的合成对照测试。 [ICML 2025 §4–5](https://arxiv.org/html/2502.10390#S4) · [ICLR 2026 §3–4](https://arxiv.org/html/2510.26792v2#S3)

## 本地运行

在项目目录下启动静态服务，然后打开 `http://127.0.0.1:8000/`。

```sh
python -m http.server 8000 --bind 127.0.0.1
```

用 Node.js 22 或更新版本运行测试和基准。

```sh
npm test
npm run benchmark -- --holdout
npm run high-precision -- --json
npm run acceptance -- --json
```

Add `--json` to export reproducible benchmark rows. Add `--timing` to measure the full prediction pipeline on your machine.

### Reproduce the Transformer · 复训 Transformer

Use a dedicated Python 3.14 environment and the CPU build of PyTorch. The training script generates its own synthetic data, separates training and validation, and exports the weights read by the browser. The independent Node benchmark uses separate data.

```sh
python -m pip install torch==2.14.1+cpu --index-url https://download.pytorch.org/whl/cpu
python scripts/train-transformer.py
```

## 参考

- [高阶马尔可夫模型](https://academic.oup.com/jrsssb/article/47/3/528/7028193)
- [多步预测方法](https://proceedings.mlr.press/v32/taieb14.html)
- [概率预测评分](https://sites.stat.washington.edu/people/raftery/Research/PDF/Gneiting2007jasa.pdf)
