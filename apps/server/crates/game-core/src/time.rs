//! The single monotonic clock the room reads, abstracted so the same game logic runs on the native
//! server and in the browser via wasm. On native it IS `std::time::Instant` (a plain re-export — zero
//! behavior change, the room keeps using real `Instant`s). On wasm there is no `Instant::now()`, so this
//! is a millis newtype whose `now()` reads a JS-injected monotonic clock (`performance.now()`), exposing
//! exactly the operations the room uses: `now()`, `duration_since`, and `Sub<Duration>`.

#[cfg(not(target_arch = "wasm32"))]
pub use std::time::Instant;

#[cfg(target_arch = "wasm32")]
pub use wasm_clock::{set_now_ms, set_wall_ms, Instant};

/// Milliseconds since the Unix epoch — the wall clock the playtime accounting stamps with. Native reads
/// the OS clock (`SystemTime`, unchanged); wasm reads the JS-injected wall clock (`Date.now()`).
#[cfg(not(target_arch = "wasm32"))]
pub fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(target_arch = "wasm32")]
pub fn epoch_ms() -> u64 {
    wasm_clock::wall_ms()
}

#[cfg(target_arch = "wasm32")]
mod wasm_clock {
    use std::cell::Cell;
    use std::ops::Sub;
    use std::time::Duration;

    thread_local! {
        // The current monotonic time in milliseconds, fed from JS (`performance.now()`) before each
        // call into the room. `Instant::now()` reads this, so the room's clock is the browser's.
        static NOW_MS: Cell<f64> = const { Cell::new(0.0) };
        // The current wall-clock time (`Date.now()`), fed from JS alongside the monotonic clock. The
        // playtime accounting stamps with this (see `epoch_ms`).
        static WALL_MS: Cell<f64> = const { Cell::new(0.0) };
    }

    /// Set the current monotonic time (milliseconds since some epoch, e.g. `performance.now()`). The wasm
    /// wrapper calls this every tick/input before driving the room, so the room's `Instant::now()` reads it.
    pub fn set_now_ms(now_ms: f64) {
        NOW_MS.with(|cell| cell.set(now_ms));
    }

    /// Set the current wall-clock time (`Date.now()`), read by `epoch_ms`.
    pub fn set_wall_ms(wall_ms: f64) {
        WALL_MS.with(|cell| cell.set(wall_ms));
    }

    /// The current wall-clock time in milliseconds since the Unix epoch (see `set_wall_ms`).
    pub fn wall_ms() -> u64 {
        WALL_MS.with(|cell| cell.get()) as u64
    }

    /// A monotonic point in time, mirroring the slice of `std::time::Instant`'s API the room uses. Holds
    /// milliseconds so it maps directly onto `performance.now()`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
    pub struct Instant {
        millis: u64,
    }

    impl Instant {
        /// The current monotonic time, read from the JS-injected clock (see `set_now_ms`).
        pub fn now() -> Self {
            Self {
                millis: NOW_MS.with(|cell| cell.get()) as u64,
            }
        }

        /// The time elapsed from `earlier` to `self`, saturating at zero (never panics on a backwards
        /// clock), exactly like `std::time::Instant::duration_since`'s saturating contract.
        pub fn duration_since(&self, earlier: Self) -> Duration {
            Duration::from_millis(self.millis.saturating_sub(earlier.millis))
        }
    }

    impl Sub<Duration> for Instant {
        type Output = Instant;
        fn sub(self, rhs: Duration) -> Instant {
            Instant {
                millis: self.millis.saturating_sub(rhs.as_millis() as u64),
            }
        }
    }

    // `now - earlier` (`Instant - Instant`) yields the elapsed `Duration`, mirroring `std::time::Instant`
    // (saturating instead of panicking on a backwards clock — the room only ever subtracts an earlier point).
    impl Sub<Instant> for Instant {
        type Output = Duration;
        fn sub(self, earlier: Instant) -> Duration {
            self.duration_since(earlier)
        }
    }
}
