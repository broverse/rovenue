// Pure-Dart port of `packages/sdk-rn/src/api/funnel.ts`'s `extractFunnelToken`
// — same rules, same order, same edge cases, deliberately NOT using `Uri`
// (mirrors the RN implementation's avoidance of the `URL` constructor,
// which is unreliable for custom schemes in RN/Hermes; Dart's `Uri.parse`
// has the same practical unreliability for arbitrary custom-scheme deep
// links, so this keeps the two façades' behavior identical byte-for-byte).

/// Extract a funnel token from a deep link / Universal Link. Recognises:
///  - Universal Link path: `…/funnels/open/<token>`
///  - `rovenue_funnel_token=<token>` query (anywhere — Rovenue-specific key)
///  - `token=<token>` query ONLY on the funnel deep-link host
///    (`…onboarding-complete…`) so an unrelated deep link's generic
///    `token=` is not mistaken for a funnel token.
///
/// Returns `null` for any non-funnel URL. Does not use [Uri.parse] — see
/// the file header.
String? extractFunnelToken(String url) {
  if (url.isEmpty) return null;

  // 1) Universal-link path: the segment after "funnels/open/".
  const marker = 'funnels/open/';
  final mi = url.indexOf(marker);
  if (mi != -1) {
    final rest = url.substring(mi + marker.length);
    final seg = rest.split('/').first.split('?').first.split('#').first;
    if (seg.isNotEmpty) return seg;
  }

  // 2) Query-string extraction (manual parse — no Uri.parse).
  final qi = url.indexOf('?');
  if (qi != -1) {
    final query = url.substring(qi + 1).split('#').first;
    String? generic;
    for (final pair in query.split('&')) {
      final eq = pair.indexOf('=');
      if (eq == -1) continue;
      final key = pair.substring(0, eq);
      final val = _safeDecode(pair.substring(eq + 1));
      if (val.isEmpty) continue;
      if (key == 'rovenue_funnel_token') return val; // Rovenue-specific → trust anywhere
      if (key == 'token') generic = val;
    }
    // Generic `token=` only on the Rovenue funnel deep-link host. Check
    // only the pre-query portion so a crafted query key like
    // `?onboarding-complete=1&token=…` cannot bypass this gate.
    final beforeQuery = url.substring(0, qi);
    if (generic != null && beforeQuery.contains('onboarding-complete')) return generic;
  }

  return null;
}

String _safeDecode(String s) {
  if (s.isEmpty) return '';
  try {
    return Uri.decodeComponent(s);
  } catch (_) {
    return s;
  }
}
