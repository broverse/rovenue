use std::sync::{Arc, Mutex};
use std::time::Duration;

use rovenue::polling::PollingScheduler;
use serial_test::serial;

#[test]
#[serial]
fn fires_when_foreground() {
    let counter = Arc::new(Mutex::new(0u32));
    let c = Arc::clone(&counter);
    let scheduler = PollingScheduler::new();
    scheduler.register("entitlements", Duration::from_millis(30), move || {
        *c.lock().unwrap() += 1;
    });
    scheduler.set_foreground(true);
    std::thread::sleep(Duration::from_millis(150));
    scheduler.shutdown();
    let n = *counter.lock().unwrap();
    assert!(n >= 3, "expected at least 3 ticks in 150ms, got {n}");
}

#[test]
#[serial]
fn paused_in_background() {
    let counter = Arc::new(Mutex::new(0u32));
    let c = Arc::clone(&counter);
    let scheduler = PollingScheduler::new();
    scheduler.register("entitlements", Duration::from_millis(20), move || {
        *c.lock().unwrap() += 1;
    });
    scheduler.set_foreground(false);
    std::thread::sleep(Duration::from_millis(100));
    let n = *counter.lock().unwrap();
    scheduler.shutdown();
    assert_eq!(n, 0, "no ticks while background");
}

#[test]
#[serial]
fn shutdown_stops_thread_cleanly() {
    let scheduler = PollingScheduler::new();
    scheduler.register("entitlements", Duration::from_millis(10), || {});
    scheduler.set_foreground(true);
    std::thread::sleep(Duration::from_millis(30));
    scheduler.shutdown();
    // Calling shutdown again is a no-op.
    scheduler.shutdown();
}
