"""Unit tests for the burst analysis in test_keystroke_timing.py.

Run: python3 -m unittest discover -s scanner/test -p 'test_timing_analysis.py'
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from test_keystroke_timing import analyze_burst, detect_terminator  # noqa: E402


def burst(text, delay_ms=10.0):
    chars = list(text)
    timestamps = [i * delay_ms / 1000.0 for i in range(len(chars))]
    return chars, timestamps


class DetectTerminatorTest(unittest.TestCase):
    def test_carriage_return_is_enter(self):
        # Raw/cbreak terminals without ICRNL deliver the Enter key as '\r'.
        self.assertEqual(detect_terminator("TEST-10042\r"), "ENTER")

    def test_newline_and_crlf_are_enter(self):
        self.assertEqual(detect_terminator("TEST-10042\n"), "ENTER")
        self.assertEqual(detect_terminator("TEST-10042\r\n"), "ENTER")

    def test_tab(self):
        self.assertEqual(detect_terminator("TEST-10042\t"), "TAB")

    def test_none(self):
        self.assertEqual(detect_terminator("TEST-10042"), "NONE")


class AnalyzeBurstTest(unittest.TestCase):
    def test_enter_burst_as_carriage_return_passes(self):
        report = analyze_burst(*burst("TEST-10042\r"))
        self.assertTrue(report["passed"], report["failures"])
        self.assertEqual(report["terminator"], "ENTER")
        self.assertEqual(report["payload"], "TEST-10042")

    def test_timing_statistics(self):
        report = analyze_burst(*burst("ABC\n", delay_ms=12.0))
        self.assertAlmostEqual(report["avg_delay_ms"], 12.0, places=6)
        self.assertAlmostEqual(report["total_duration_ms"], 36.0, places=6)

    def test_missing_terminator_fails(self):
        report = analyze_burst(*burst("TEST-10042"))
        self.assertFalse(report["passed"])
        self.assertIn("Missing barcode terminator (Enter/Tab)", report["failures"])

    def test_slow_burst_warns_but_passes(self):
        report = analyze_burst(*burst("12345\n", delay_ms=50.0))
        self.assertTrue(report["passed"])
        self.assertIn("Inter-char delay is slow (>40ms)", report["warnings"])

    def test_single_char_does_not_crash(self):
        report = analyze_burst(["\r"], [0.0])
        self.assertFalse(report["passed"])
        self.assertEqual(report["min_delay_ms"], 0.0)
        self.assertEqual(report["warnings"], [])


if __name__ == "__main__":
    unittest.main()
