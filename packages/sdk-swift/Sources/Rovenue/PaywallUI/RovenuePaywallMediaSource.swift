//
//  RovenuePaywallMediaSource.swift
//  THE one rule deciding whether a `video` or `lottie` node has a source worth
//  mounting — asked before mount, because a carousel fixes its page and dot
//  counts from what its children report and a node that mounts and then draws
//  nothing is still a page to its parent.
//
//  This file exists because the rule used to be spelled INLINE THREE TIMES on
//  this platform (once in `lottieRenderRequest`, once in `lottieCanRender`,
//  once in `videoHasParsableSource`) — three spellings of one rule is how a
//  cross-platform divergence starts. Web (`nodes.tsx`) and Android
//  (`NodeViewFactory.kt`) each have exactly one; now so does iOS.
//

import Foundation

/// The one source string that is NOT usable: nothing left after trimming.
/// Named so the predicate below reads as the rule it implements rather than as
/// an incidental comparison against a bare literal.
let blankMediaSource = ""

/// The character set trimmed before the blank test. `.whitespacesAndNewlines`
/// is chosen deliberately over `.whitespaces`: it is what JavaScript's
/// `String.prototype.trim` (web) and Kotlin's `String.trim()` (Android) both
/// remove, so a source containing only a newline gets the same answer on all
/// three platforms.
let mediaSourceTrimSet = CharacterSet.whitespacesAndNewlines

/// Whether a theme-resolved media source is USABLE.
///
/// THE RULE, identical on iOS, web and Android: a media source is usable when
/// it is non-blank after trimming leading and trailing whitespace. Nothing
/// more. There is deliberately NO syntactic URL validation here.
///
/// Why no URL parsing: validating URL *syntax* is the platform's job at LOAD
/// time — a malformed URL simply fails to load and takes the existing error
/// path to `fallback`. What this pre-mount check exists for is the one case a
/// renderer cannot recover from: a source that is ABSENT, which is exactly the
/// builder's `newNode` default (`url: { light: "" }`) and its whitespace
/// cousins, so every freshly added media node is in this state until a URL is
/// pasted.
///
/// Why not "whatever `URL(string:)` says": the three platforms' parsers do not
/// agree and never will. `URL(string:)` here accepts `" "`, `"not a url"` and
/// `"://x"`; Android's `Uri` rule rejected all three; the browser's WHATWG
/// parser accepts two of the three. A whitespace-only source therefore left a
/// phantom carousel page and dot ON THIS PLATFORM ONLY — precisely the defect
/// the pre-mount check exists to prevent. Worse, this platform's own answer is
/// version-dependent (CFURL before iOS 17, an RFC-3986 parser after), so a
/// rule pinned to parser agreement drifts on its own. A rule WE define is
/// stable; a rule three URL parsers happen to share is not.
///
/// The inputs `""`, `" "`, `"a/b.mp4"`, `"not a url"` and `"https://x/a.mp4"`
/// are asserted against this function in `PaywallMediaSourceTests.swift`, and
/// against its two siblings in `renderer.test.tsx` and `NodeViewFactoryTest.kt`
/// — the same inputs with the same answers, so the agreement is pinned rather
/// than assumed.
func mediaSourceIsUsable(_ rawSource: String) -> Bool {
    rawSource.trimmingCharacters(in: mediaSourceTrimSet) != blankMediaSource
}
