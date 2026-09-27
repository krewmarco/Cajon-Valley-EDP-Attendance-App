// Native (host) unit tests for include/payload_rules.h
// Run: pio test -e native

#include <string.h>
#include <unity.h>

#include "payload_rules.h"

void setUp() {}
void tearDown() {}

static void test_sanitizer_keeps_alphanumerics_and_hyphen() {
    char out[32];
    size_t n = sanitizePayloadChars("TEST-10042", out, sizeof(out));
    TEST_ASSERT_EQUAL_UINT(10, n);
    TEST_ASSERT_EQUAL_STRING("TEST-10042", out);
}

static void test_sanitizer_strips_underscore() {
    char out[32];
    sanitizePayloadChars("ABC_123", out, sizeof(out));
    TEST_ASSERT_EQUAL_STRING("ABC123", out);
}

static void test_sanitizer_strips_control_and_punctuation() {
    char out[32];
    sanitizePayloadChars("89\t01\r\n23; rm -rf\x1b[A", out, sizeof(out));
    TEST_ASSERT_EQUAL_STRING("890123rm-rfA", out);
}

static void test_sanitizer_all_invalid_yields_empty() {
    char out[8];
    size_t n = sanitizePayloadChars("_!@ \n", out, sizeof(out));
    TEST_ASSERT_EQUAL_UINT(0, n);
    TEST_ASSERT_EQUAL_STRING("", out);
}

static void test_sanitizer_respects_output_capacity() {
    char out[5];
    size_t n = sanitizePayloadChars("1234567890", out, sizeof(out));
    TEST_ASSERT_EQUAL_UINT(4, n);
    TEST_ASSERT_EQUAL_STRING("1234", out);
}

static void test_cooldown_is_250ms() {
    TEST_ASSERT_FALSE(isCooldownElapsed(1249, 1000, 250));
    TEST_ASSERT_TRUE(isCooldownElapsed(1250, 1000, 250));
}

static void test_first_injection_is_never_throttled() {
    TEST_ASSERT_TRUE(isCooldownElapsed(10, 0, 250));
}

static void test_cooldown_survives_millis_rollover() {
    TEST_ASSERT_FALSE(isCooldownElapsed(100, 0xFFFFFF00u, 500));
    TEST_ASSERT_TRUE(isCooldownElapsed(300, 0xFFFFFF00u, 500));
}

static void test_burst_delay_clamp() {
    TEST_ASSERT_EQUAL_UINT16(2, clampBurstDelay(0, 2, 50));
    TEST_ASSERT_EQUAL_UINT16(8, clampBurstDelay(8, 2, 50));
    TEST_ASSERT_EQUAL_UINT16(50, clampBurstDelay(500, 2, 50));
}

int main() {
    UNITY_BEGIN();
    RUN_TEST(test_sanitizer_keeps_alphanumerics_and_hyphen);
    RUN_TEST(test_sanitizer_strips_underscore);
    RUN_TEST(test_sanitizer_strips_control_and_punctuation);
    RUN_TEST(test_sanitizer_all_invalid_yields_empty);
    RUN_TEST(test_sanitizer_respects_output_capacity);
    RUN_TEST(test_cooldown_is_250ms);
    RUN_TEST(test_first_injection_is_never_throttled);
    RUN_TEST(test_cooldown_survives_millis_rollover);
    RUN_TEST(test_burst_delay_clamp);
    return UNITY_END();
}
