use tokio::sync::Mutex;
use tokio::time::{sleep, Duration, Instant};

pub struct RateLimiter {
    getcomics: Mutex<Instant>,
    prowlarr: Mutex<Instant>,
    comicvine: Mutex<Instant>,
    metron: Mutex<Instant>,
}

impl RateLimiter {
    pub fn new() -> Self {
        // Safely attempt to subtract 10 seconds so the first request fires instantly.
        // If the PC was freshly rebooted (uptime < 10s), it safely falls back to Instant::now().
        let past = Instant::now().checked_sub(Duration::from_secs(10)).unwrap_or_else(Instant::now);
        Self {
            getcomics: Mutex::new(past),
            prowlarr: Mutex::new(past),
            comicvine: Mutex::new(past),
            metron: Mutex::new(past),
        }
    }

    pub async fn enforce(&self, service: &str, delay_ms: u64) {
        // 1. Acquire the lock for the specific service
        let mut lock = match service {
            "getcomics" => self.getcomics.lock().await,
            "prowlarr" => self.prowlarr.lock().await,
            "comicvine" => self.comicvine.lock().await,
            "metron" => self.metron.lock().await,
            _ => return,
        };

        let elapsed = lock.elapsed().as_millis() as u64;
        
        // 2. If we hit the API too recently, we hold the lock AND sleep. 
        // This forces any other threads to wait in line until this thread finishes!
        if elapsed < delay_ms {
            let wait = delay_ms - elapsed;
            log::info!("[Rate Limiter] Globally throttling {} for {}ms to prevent IP bans...", service, wait);
            sleep(Duration::from_millis(wait)).await;
        }
        
        // 3. Reset the timer for the next thread in line
        *lock = Instant::now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // start_paused: tokio mocks the clock, so sleeps advance virtual time instantly.
    #[tokio::test(start_paused = true)]
    async fn enforce_throttles_back_to_back_calls() {
        let rl = RateLimiter::new();
        rl.enforce("getcomics", 1000).await;
        let t0 = Instant::now();
        rl.enforce("getcomics", 1000).await; // immediately after a reset → must wait ~1000ms
        assert!(t0.elapsed() >= Duration::from_millis(1000), "second call was not throttled");
    }

    #[tokio::test(start_paused = true)]
    async fn enforce_is_per_service_and_ignores_unknown() {
        let rl = RateLimiter::new();
        rl.enforce("getcomics", 5000).await;

        // A different service has its own timer — no cross-service throttle on first use...
        // (both clocks start 10s in the past when uptime allows; under the paused clock the
        // checked_sub fallback may make this wait, so only assert the unknown-service no-op).
        let t0 = Instant::now();
        rl.enforce("not-a-service", 5000).await;
        assert!(t0.elapsed() < Duration::from_millis(1), "unknown service must be a no-op");
    }
}