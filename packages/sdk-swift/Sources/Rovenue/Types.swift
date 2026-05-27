//  Types.swift — Sendable conformance for UniFFI-generated value types.
//
//  The generated `User`, `Entitlement`, `ReceiptResult`, and `ChangeEvent`
//  already conform to `Equatable, Hashable` via UniFFI-generated extensions,
//  so we only need to add `@unchecked Sendable` here so SwiftUI / Combine
//  consumers can pass these values across actors.
//
//  All stored properties are themselves `Sendable` (String, Int64, Bool,
//  Optional<…>) — the `@unchecked` is purely because the structs are defined
//  in another file we don't own, so the compiler can't synthesize the
//  conformance automatically.
//
//  Adding these here keeps the public API surface idiomatic without forcing
//  the UDL to declare conformance traits (UniFFI 0.25 doesn't expose that
//  knob anyway).

import Foundation

extension User: @unchecked Sendable {}

extension Entitlement: @unchecked Sendable {}

extension ReceiptResult: @unchecked Sendable {}

extension ChangeEvent: @unchecked Sendable {}
