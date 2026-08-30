// Ported from packages/sdk-rn/src/api/funnel.test.ts's `describe("extractFunnelToken", ...)`
// block — same cases, same expectations, so the two façades' deep-link
// extraction stays behaviorally identical.
import 'package:flutter_test/flutter_test.dart';
import 'package:rovenue_flutter/src/funnel_token.dart';

void main() {
  final tok = List.filled(48, 'a').join(); // 40-64 char funnel token

  test('extracts from a Universal Link path', () {
    expect(extractFunnelToken('https://links.acme.com/universal/funnels/open/$tok'), tok);
  });

  test('extracts from a path with trailing query/fragment', () {
    expect(extractFunnelToken('https://d/universal/funnels/open/$tok?x=1#y'), tok);
  });

  test("stops the path token at the next '/' (real funnel tokens have no slash)", () {
    expect(extractFunnelToken('https://d/universal/funnels/open/$tok/extra'), tok);
  });

  test('extracts from the funnel deep-link query (token= on onboarding-complete)', () {
    expect(extractFunnelToken('myapp://onboarding-complete?token=$tok'), tok);
  });

  test('extracts rovenue_funnel_token= anywhere', () {
    expect(extractFunnelToken('myapp://whatever?rovenue_funnel_token=$tok'), tok);
  });

  test('ignores a generic token= on a non-funnel host', () {
    expect(extractFunnelToken('myapp://reset-password?token=$tok'), isNull);
  });

  test('does NOT honor token= when onboarding-complete appears only in the query', () {
    expect(extractFunnelToken('myapp://reset-password?onboarding-complete=1&token=$tok'), isNull);
  });

  test('returns null for a non-funnel URL', () {
    expect(extractFunnelToken('https://example.com/page?x=1'), isNull);
  });

  test('returns null for empty/garbage', () {
    expect(extractFunnelToken(''), isNull);
    expect(extractFunnelToken('not a url'), isNull);
  });
}
