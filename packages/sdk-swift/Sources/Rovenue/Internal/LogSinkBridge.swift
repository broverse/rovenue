//  LogSinkBridge.swift — forwards Rust core LogRecord callbacks into the
//  Swift façade's static emit / setLogHandler machinery.
//
//  The Rust core is the authoritative emitter of all operation logs. This
//  bridge receives each LogRecord over the FFI and converts it to a LogEntry
//  before routing it to every registered Swift log handler.

import Foundation

internal final class LogSinkBridge: LogSink, @unchecked Sendable {
    /// Called by UniFFI on the Rust log-sink thread.
    func onLog(record: LogRecord) {
        let level: String
        switch record.level {
        case .off: return
        case .error: level = "error"
        case .warn: level = "warn"
        case .info: level = "info"
        case .debug: level = "debug"
        case .trace: level = "trace"
        }
        let data: [String: String]? = record.fields.isEmpty ? nil : record.fields
        Rovenue.emit(LogEntry(level: level, message: record.message, data: data))
    }
}
