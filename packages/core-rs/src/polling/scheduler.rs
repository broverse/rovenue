use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

type Tick = Arc<dyn Fn() + Send + Sync>;

struct Registration {
    interval: Duration,
    last_fired: Mutex<Option<Instant>>,
    tick: Tick,
}

pub struct PollingScheduler {
    inner: Arc<SchedulerInner>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

struct SchedulerInner {
    registrations: Mutex<Vec<(String, Arc<Registration>)>>,
    foreground: AtomicBool,
    running: AtomicBool,
}

impl PollingScheduler {
    pub fn new() -> Self {
        let inner = Arc::new(SchedulerInner {
            registrations: Mutex::new(Vec::new()),
            foreground: AtomicBool::new(false),
            running: AtomicBool::new(true),
        });
        let inner_clone = Arc::clone(&inner);
        let handle = thread::spawn(move || run_loop(inner_clone));
        Self {
            inner,
            thread: Mutex::new(Some(handle)),
        }
    }

    pub fn register(
        &self,
        name: &str,
        interval: Duration,
        tick: impl Fn() + Send + Sync + 'static,
    ) {
        let mut regs = self.inner.registrations.lock().expect("regs poisoned");
        regs.push((
            name.to_string(),
            Arc::new(Registration {
                interval,
                last_fired: Mutex::new(None),
                tick: Arc::new(tick),
            }),
        ));
    }

    pub fn set_foreground(&self, foreground: bool) {
        self.inner.foreground.store(foreground, Ordering::SeqCst);
    }

    /// Clear every registration's last-fired time so the loop fires each task on
    /// its next tick. Used on foreground transitions to refresh immediately
    /// instead of waiting out the remaining interval.
    pub fn reset_cadence(&self) {
        let regs = self.inner.registrations.lock().expect("regs poisoned");
        for (_name, reg) in regs.iter() {
            *reg.last_fired.lock().expect("last_fired poisoned") = None;
        }
    }

    pub fn shutdown(&self) {
        if self.inner.running.swap(false, Ordering::SeqCst) {
            // Wake up a sleeping loop quickly.
            self.inner.foreground.store(false, Ordering::SeqCst);
        }
        let mut g = self.thread.lock().expect("thread mutex poisoned");
        if let Some(h) = g.take() {
            let _ = h.join();
        }
    }
}

impl Default for PollingScheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for PollingScheduler {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_loop(inner: Arc<SchedulerInner>) {
    let tick_resolution = Duration::from_millis(10);
    while inner.running.load(Ordering::SeqCst) {
        if !inner.foreground.load(Ordering::SeqCst) {
            thread::sleep(tick_resolution);
            continue;
        }
        let regs = inner.registrations.lock().expect("regs poisoned").clone();
        let now = Instant::now();
        for (_name, reg) in regs {
            let mut last = reg.last_fired.lock().expect("last_fired poisoned");
            let due = match *last {
                None => true,
                Some(t) => now.duration_since(t) >= reg.interval,
            };
            if due {
                *last = Some(now);
                drop(last);
                (reg.tick)();
            }
        }
        thread::sleep(tick_resolution);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_cadence_refires_immediately_after_reforeground() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let sched = PollingScheduler::new();
        let count = Arc::new(AtomicUsize::new(0));
        {
            let count = Arc::clone(&count);
            sched.register("t", std::time::Duration::from_secs(3600), move || {
                count.fetch_add(1, Ordering::SeqCst);
            });
        }
        sched.set_foreground(true);
        std::thread::sleep(std::time::Duration::from_millis(60));
        assert_eq!(count.load(Ordering::SeqCst), 1, "first foreground fires once");

        sched.reset_cadence();
        std::thread::sleep(std::time::Duration::from_millis(60));
        assert_eq!(count.load(Ordering::SeqCst), 2, "reset_cadence re-fires immediately");
    }
}
