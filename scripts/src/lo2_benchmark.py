#!/usr/bin/env python3
"""Small, offline LO2v2 per-test telemetry benchmark.

This reads the official per-test JSON metrics layout without extracting the zip.
The `correct` task is the control label; other named tasks deliberately trigger
an API error and are positive only for this narrowly defined test-identification
benchmark. This is not a service-failure or remediation benchmark.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import zipfile
from collections import defaultdict
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO


CPU_FILE = "metric_container_cpu_usage_seconds_total.json"
MEMORY_FILE = "metric_container_memory_working_set_bytes.json"
SOURCE_DOI = "10.5281/zenodo.18937117"
SOURCE_FILE_MD5 = "2fe6548d1ad9115ad37e7663015b907c"


def _is_app_service(metric: dict[str, Any]) -> bool:
    service = str(metric.get("container_label_com_docker_compose_service", ""))
    return service.startswith("oauth2-")


def _series(payload: Any, filename: str) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        payload = payload.get("data", {}).get("result", [])
    if not isinstance(payload, list):
        raise ValueError(f"Unsupported LO2v2 metric JSON shape in {filename}.")
    return [row for row in payload if isinstance(row, dict)]


def _values(payload: Any, filename: str, *, cpu_counter: bool) -> dict[float, float]:
    """Aggregate one metric into per-second summed application-container values."""
    totals: defaultdict[float, float] = defaultdict(float)
    for row in _series(payload, filename):
        labels = row.get("metric") or {}
        if not isinstance(labels, dict) or not _is_app_service(labels):
            continue
        if cpu_counter and labels.get("cpu") not in (None, "total"):
            continue
        observations = row.get("values")
        if not isinstance(observations, list):
            continue
        parsed: list[tuple[float, float]] = []
        for pair in observations:
            if not isinstance(pair, list) or len(pair) < 2:
                continue
            try:
                timestamp, value = float(pair[0]), float(pair[1])
            except (TypeError, ValueError):
                continue
            if math.isfinite(timestamp) and math.isfinite(value):
                parsed.append((timestamp, value))
        parsed.sort()
        if cpu_counter:
            for (previous_time, previous_value), (timestamp, value) in zip(parsed, parsed[1:]):
                elapsed = timestamp - previous_time
                delta = value - previous_value
                if elapsed > 0 and delta >= 0:
                    totals[timestamp] += delta / elapsed
        else:
            for timestamp, value in parsed:
                totals[timestamp] += value
    return dict(totals)


def _load_test_samples(read_metric, tests: dict[tuple[str, str], dict[str, str]]) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    for (run, test), files in sorted(tests.items()):
        if CPU_FILE not in files or MEMORY_FILE not in files:
            raise ValueError(f"{run}/{test} is missing one of the required CPU or memory metric files.")
        cpu_payload = json.load(read_metric(files[CPU_FILE]))
        memory_payload = json.load(read_metric(files[MEMORY_FILE]))
        cpu = _values(cpu_payload, files[CPU_FILE], cpu_counter=True)
        memory = _values(memory_payload, files[MEMORY_FILE], cpu_counter=False)
        common_times = sorted(cpu.keys() & memory.keys())
        points = [
            {"timestamp": timestamp, "cpuCores": cpu[timestamp], "memoryBytes": memory[timestamp]}
            for timestamp in common_times
        ]
        if len(points) < 3:
            raise ValueError(
                f"{run}/{test} has fewer than 3 aligned app-container CPU/memory samples; "
                "the benchmark will not silently omit it."
            )
        samples.append({"run": run, "test": test, "label": int(test != "correct"), "points": points})
    if not samples:
        raise ValueError("No LO2v2 per-test metric folders were found.")
    return samples


def _read_zip(path: Path) -> list[dict[str, Any]]:
    with zipfile.ZipFile(path) as archive:
        tests: dict[tuple[str, str], dict[str, str]] = {}
        for name in archive.namelist():
            parts = PurePosixPath(name).parts
            if not parts or parts[-1] not in (CPU_FILE, MEMORY_FILE):
                continue
            try:
                metrics_index = parts.index("metrics")
            except ValueError:
                continue
            if metrics_index < 2:
                continue
            run = next((part for part in parts[:metrics_index] if part.startswith("LO2_run_")), None)
            if run is None:
                continue
            test = parts[metrics_index - 1]
            tests.setdefault((run, test), {})[parts[-1]] = name

        def read_metric(name: str) -> BinaryIO:
            return archive.open(name)

        return _load_test_samples(read_metric, tests)


def _read_directory(path: Path) -> list[dict[str, Any]]:
    tests: dict[tuple[str, str], dict[str, str]] = {}
    metric_dirs = (p for p in path.rglob("metrics") if p.is_dir())
    for metrics_dir in metric_dirs:
        test_dir = metrics_dir.parent
        run_dir = test_dir.parent
        if not run_dir.name.startswith("LO2_run_"):
            continue
        files = tests.setdefault((run_dir.name, test_dir.name), {})
        for filename in (CPU_FILE, MEMORY_FILE):
            candidate = metrics_dir / filename
            if candidate.is_file():
                files[filename] = str(candidate)

    def read_metric(name: str) -> BinaryIO:
        return Path(name).open("rb")

    return _load_test_samples(read_metric, tests)


def _median_scale(values: list[float]) -> tuple[float, float]:
    center = statistics.median(values)
    mad = statistics.median(abs(value - center) for value in values)
    scale = 1.4826 * mad
    if scale <= 0:
        ordered = sorted(values)
        lower = ordered[int((len(ordered) - 1) * 0.25)]
        upper = ordered[int((len(ordered) - 1) * 0.75)]
        scale = (upper - lower) / 1.349
    if scale <= 0:
        scale = max(abs(center) * 0.01, 1e-9)
    return center, scale


def _evaluate(
    samples: list[dict[str, Any]], z_threshold: float, fraction_threshold: float
) -> dict[str, Any]:
    by_run: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for sample in samples:
        by_run[sample["run"]].append(sample)

    predictions: list[tuple[int, int]] = []
    run_reports = []
    calibration_counts = {}
    for run, run_samples in sorted(by_run.items()):
        control = [point for sample in run_samples if sample["test"] == "correct" for point in sample["points"]]
        if not control:
            raise ValueError(f"{run} has no directory named 'correct'; no control baseline is available.")
        control.sort(key=lambda point: point["timestamp"])
        if len(control) < 10:
            raise ValueError(f"{run} has fewer than 10 control observations; refusing an unstable calibration.")
        split = min(len(control) - 1, max(3, int(len(control) * 0.6)))
        calibration = control[:split]
        held_out_control = control[split:]
        cpu_center, cpu_scale = _median_scale([point["cpuCores"] for point in calibration])
        memory_center, memory_scale = _median_scale([point["memoryBytes"] for point in calibration])
        calibration_counts[run] = len(calibration)
        run_results = []
        for sample in sorted(run_samples, key=lambda item: item["test"]):
            points = held_out_control if sample["test"] == "correct" else sample["points"]
            if not points:
                raise ValueError(f"{run}/correct has no held-out control observations.")
            flagged = 0
            max_z = 0.0
            for point in points:
                cpu_z = abs(point["cpuCores"] - cpu_center) / cpu_scale
                memory_z = abs(point["memoryBytes"] - memory_center) / memory_scale
                score = max(cpu_z, memory_z)
                max_z = max(max_z, score)
                flagged += int(score >= z_threshold)
            fraction = flagged / len(points)
            predicted = int(fraction >= fraction_threshold)
            actual = sample["label"]
            predictions.append((actual, predicted))
            run_results.append({
                "test": sample["test"],
                "target": "error-triggering task" if actual else "correct control",
                "predicted": "error-triggering task" if predicted else "correct control",
                "observations": len(points),
                "outlierFraction": round(fraction, 4),
                "maxRobustZ": round(max_z, 4),
            })
        run_reports.append({
            "run": run,
            "controlObservationsUsedForCalibration": len(calibration),
            "tests": run_results,
        })

    tp = sum(actual == 1 and predicted == 1 for actual, predicted in predictions)
    tn = sum(actual == 0 and predicted == 0 for actual, predicted in predictions)
    fp = sum(actual == 0 and predicted == 1 for actual, predicted in predictions)
    fn = sum(actual == 1 and predicted == 0 for actual, predicted in predictions)
    positives, negatives = tp + fn, tn + fp
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / positives if positives else 0.0
    specificity = tn / negatives if negatives else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    accuracy = (tp + tn) / len(predictions)
    return {
        "benchmark": "LO2v2 per-test value-only error-test identification",
        "dataset": {
            "doi": SOURCE_DOI,
            "license": "CC-BY-4.0",
            "officialExampleFile": "light-oauth2-metrics.zip",
            "officialExampleFileMd5": SOURCE_FILE_MD5,
            "runs": len(by_run),
            "tests": len(predictions),
            "positiveTests": positives,
            "controlTests": negatives,
        },
        "targetDefinition": (
            "A test directory named 'correct' is the negative control. Every other named test "
            "deliberately triggers an API error response and is positive for this narrow task. "
            "These labels do not mean that a service outage or infrastructure anomaly occurred."
        ),
        "method": {
            "type": "unsupervised robust value-only baseline",
            "signals": [
                "per-second summed CPU-core rate across oauth2-* containers",
                "summed container_memory_working_set_bytes across oauth2-* containers",
            ],
            "calibration": "First 60% of timestamp-ordered observations in each run's correct test.",
            "pointOutlierRule": f"Either signal is at least {z_threshold:g} robust MAD-scaled deviations from its control median.",
            "testDecision": f"Positive when at least {fraction_threshold:.1%} of that test's observations are outliers.",
            "remediationActionsUsed": False,
            "qLearningEvaluated": False,
        },
        "metrics": {
            "truePositive": tp,
            "falsePositive": fp,
            "trueNegative": tn,
            "falseNegative": fn,
            "accuracy": round(accuracy, 4),
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "specificity": round(specificity, 4),
            "f1": round(f1, 4),
            "balancedAccuracy": round((recall + specificity) / 2, 4) if positives and negatives else None,
        },
        "runs": run_reports,
        "limitations": [
            "The official reproduction package contains one example run; this is a pilot result, not independent run-level generalization.",
            "The target is correct-task versus deliberately error-triggering-task identification, not service-failure detection, root-cause diagnosis, or treatment effectiveness.",
            "This evaluates a value-only telemetry baseline. It does not train or validate Quasar's Q-learning remediation policy.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, help="Official LO2v2 per-test metrics ZIP or extracted directory.")
    parser.add_argument("--out", help="Optional path for a JSON copy of the report.")
    parser.add_argument("--z-threshold", type=float, default=3.5)
    parser.add_argument("--fraction-threshold", type=float, default=0.1)
    args = parser.parse_args()
    if not math.isfinite(args.z_threshold) or args.z_threshold <= 0:
        parser.error("--z-threshold must be a finite positive number")
    if not math.isfinite(args.fraction_threshold) or not 0 < args.fraction_threshold <= 1:
        parser.error("--fraction-threshold must be in (0, 1]")

    source = Path(args.dataset).expanduser()
    if not source.exists():
        parser.error(f"Dataset path does not exist: {source}")
    if source.is_file() and zipfile.is_zipfile(source):
        samples = _read_zip(source)
    elif source.is_dir():
        samples = _read_directory(source)
    else:
        parser.error("Dataset must be an LO2v2 ZIP archive or extracted dataset directory.")
    report = _evaluate(samples, args.z_threshold, args.fraction_threshold)
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.out:
        output = Path(args.out).expanduser()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8")
    sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        sys.stderr.write(f"LO2v2 benchmark failed: {error}\n")
        raise SystemExit(1)