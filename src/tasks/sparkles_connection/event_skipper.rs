//! Helper for heuristically skipping events keeping only most meaningful ones at low zoom levels.

/// Generalized skip logic helper for both instant and range events
pub struct EventSkipper {
    skip_thr: u64,
    max_events: usize,
    
    // State for tracking skipping patterns
    keep_cnt: usize,
    skip_cnt: usize,
    counter: usize,
    cycle_len: usize,
    
    // Statistics
    skipped_count: usize,
    total_count: usize,
}

impl EventSkipper {
    /// Create a new EventSkipper with the given threshold and maximum events
    pub fn new(skip_thr: u64, max_events: usize, total_events: usize) -> Self {
        let (keep_cnt, skip_cnt) = if total_events > max_events {
            // Too many events - use skip logic
            let skip_cnt = (total_events + max_events - 1) / max_events; // ceil division
            (1, skip_cnt)
        } else if total_events > 0 {
            // Few events - keep more copies of each
            let keep_cnt = max_events / total_events;
            (keep_cnt, 1)
        } else {
            (1, 1)
        };
        
        let cycle_len = keep_cnt + skip_cnt;
        
        Self {
            skip_thr,
            max_events,
            keep_cnt,
            skip_cnt,
            counter: 0,
            cycle_len,
            skipped_count: 0,
            total_count: 0,
        }
    }
    
    /// Determine if an instant event should be kept based on distance from previous event
    pub fn should_keep_instant(&mut self, tm_diff: u64) -> bool {
        self.total_count += 1;
        
        let should_keep = if tm_diff < self.skip_thr {
            // Events are close together - apply skip logic
            let keep = self.counter < self.keep_cnt;
            self.counter = (self.counter + 1) % self.cycle_len;
            keep
        } else {
            // Events are far apart - always keep and reset counter
            self.counter = 0;
            true
        };
        
        if !should_keep {
            self.skipped_count += 1;
        }
        
        should_keep
    }
    
    /// Determine if a range event should be kept based on distance between starts and duration
    pub fn should_keep_range(&mut self, start_distance: u64, duration: u64) -> bool {
        self.total_count += 1;
        
        // Apply threshold to both distance between starts and duration
        let should_keep = if start_distance < self.skip_thr && duration < self.skip_thr {
            // Both distance and duration are small - apply skip logic
            let keep = self.counter < self.keep_cnt;
            self.counter = (self.counter + 1) % self.cycle_len;
            keep
        } else {
            // Either distance or duration is large - always keep and reset counter
            self.counter = 0;
            true
        };
        
        if !should_keep {
            self.skipped_count += 1;
        }
        
        should_keep
    }
    
    /// Get the number of events that were skipped
    pub fn skipped_count(&self) -> usize {
        self.skipped_count
    }
    
    /// Get the total number of events processed
    pub fn total_count(&self) -> usize {
        self.total_count
    }
    
    /// Reset the skipper state (useful when processing multiple threads)
    pub fn reset(&mut self) {
        self.counter = 0;
        self.skipped_count = 0;
        self.total_count = 0;
    }
}

/// Helper struct to manage skipping for both instant and range events
pub struct EventSkippingProcessor {
    instant_skipper: EventSkipper,
    range_skipper: EventSkipper,
}

impl EventSkippingProcessor {
    pub fn new(skip_thr: u64, max_events: usize, instant_count: usize, range_count: usize) -> Self {
        Self {
            instant_skipper: EventSkipper::new(skip_thr, max_events, instant_count),
            range_skipper: EventSkipper::new(skip_thr, max_events, range_count),
        }
    }
    
    pub fn should_keep_instant(&mut self, tm_diff: u64) -> bool {
        self.instant_skipper.should_keep_instant(tm_diff)
    }
    
    pub fn should_keep_range(&mut self, start_distance: u64, duration: u64) -> bool {
        self.range_skipper.should_keep_range(start_distance, duration)
    }
    
    pub fn get_stats(&self) -> (usize, usize, usize, usize) {
        (
            self.instant_skipper.skipped_count(),
            self.range_skipper.skipped_count(),
            self.instant_skipper.total_count(),
            self.range_skipper.total_count(),
        )
    }
}