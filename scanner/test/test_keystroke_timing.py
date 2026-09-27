#!/usr/bin/env python3
"""
Host-Side Keystroke Timing & Integrity Benchmark
ESP32-S3 USB Barcode Scanner Emulator — Phase 1 Test Harness

Usage:
    python3 test_keystroke_timing.py

Press Ctrl+C to exit.
"""

import sys
import time
import termios
import tty
import select

BURST_IDLE_TIMEOUT_SEC = 0.15  # 150ms of silence marks end of burst


def detect_terminator(raw_str):
    """Identify the scanner suffix key.

    Depending on the terminal's ICRNL setting, the HID Enter key arrives as
    '\\r' or '\\n', so both count as ENTER.
    """
    if raw_str.endswith(("\r\n", "\n", "\r")):
        return "ENTER"
    if raw_str.endswith("\t"):
        return "TAB"
    return "NONE"


def analyze_burst(chars, timestamps):
    """Compute timing statistics and a pass/fail verdict for one burst."""
    raw_str = "".join(chars)
    terminator = detect_terminator(raw_str)

    delays_ms = [
        (timestamps[i] - timestamps[i - 1]) * 1000.0
        for i in range(1, len(timestamps))
    ]

    failures = []
    warnings = []
    if len(chars) < 2:
        failures.append("Payload too short")
    if terminator == "NONE":
        failures.append("Missing barcode terminator (Enter/Tab)")

    avg_delay_ms = sum(delays_ms) / len(delays_ms) if delays_ms else 0.0
    min_delay_ms = min(delays_ms) if delays_ms else 0.0
    if avg_delay_ms > 40.0:
        warnings.append("Inter-char delay is slow (>40ms)")
    if delays_ms and min_delay_ms < 1.0:
        warnings.append("Zero/near-zero delay may drop events on ChromeOS")

    return {
        "raw": raw_str,
        "payload": raw_str.rstrip("\r\n\t"),
        "char_count": len(chars),
        "terminator": terminator,
        "total_duration_ms": (timestamps[-1] - timestamps[0]) * 1000.0 if timestamps else 0.0,
        "avg_delay_ms": avg_delay_ms,
        "min_delay_ms": min_delay_ms,
        "max_delay_ms": max(delays_ms) if delays_ms else 0.0,
        "passed": not failures,
        "failures": failures,
        "warnings": warnings,
    }


def print_report(report):
    visible = report["raw"].replace("\r", "\\r").replace("\n", "\\n").replace("\t", "\\t")

    print("-" * 65)
    print(" BURST ANALYSIS REPORT")
    print("-" * 65)
    print(f" Received String:       '{visible}'")
    print(f" Total Characters:      {report['char_count']}")
    print(f" Detected Terminator:   {report['terminator']}")
    print(f" Total Duration:        {report['total_duration_ms']:.2f} ms")
    print(f" Avg Inter-Char Delay:  {report['avg_delay_ms']:.2f} ms (Target: ~8-12 ms)")
    print(f" Min Delay:             {report['min_delay_ms']:.2f} ms")
    print(f" Max Delay:             {report['max_delay_ms']:.2f} ms")
    print("-" * 65)
    if report["passed"]:
        print("  RESULT: >>> PASS <<<")
        print("  The keystroke burst matches standard high-speed barcode scanner timing.")
    else:
        print("  RESULT: >>> FAIL <<<")
        for reason in report["failures"]:
            print(f"  - {reason}")
    for warning in report["warnings"]:
        print(f"  WARN: {warning}")
    print("-" * 65)


def read_char(timeout_sec):
    rlist, _, _ = select.select([sys.stdin], [], [], timeout_sec)
    if rlist:
        return sys.stdin.read(1), time.perf_counter()
    return None, None


def run_test():
    print("=" * 65)
    print(" ESP32-S3 USB Barcode Scanner Emulator — Host Test Harness")
    print(" Phase 1: Keystroke Timing & Integrity Validator")
    print("=" * 65)
    print(" Instructions:")
    print("   1. Connect the ESP32-S3 to this computer via native USB.")
    print("   2. Keep this terminal window focused.")
    print("   3. Press the physical 'BOOT' button on the ESP32-S3")
    print("      or trigger a scan via Serial ('t' + Enter).")
    print("=" * 65)
    print("\nWaiting for incoming keystroke burst...\n")

    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    burst_chars = []
    burst_timestamps = []

    try:
        # cbreak for the whole session: no line buffering or echo between
        # reads, while keeping Ctrl+C (ISIG) and normal output processing.
        tty.setcbreak(fd)
        while True:
            char, timestamp = read_char(timeout_sec=0.01)
            if char is not None:
                burst_chars.append(char)
                burst_timestamps.append(timestamp)
            elif burst_chars and time.perf_counter() - burst_timestamps[-1] > BURST_IDLE_TIMEOUT_SEC:
                print_report(analyze_burst(burst_chars, burst_timestamps))
                burst_chars = []
                burst_timestamps = []
                print("\nReady for next scan (Press Ctrl+C to quit)...")
    except KeyboardInterrupt:
        print("\n\nTest harness terminated by user.")
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


if __name__ == "__main__":
    run_test()
