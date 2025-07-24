import { makeAutoObservable, action } from 'mobx';
import trace from "../trace.js";
import ConnectionThreadStore from './ConnectionThread.js';

function generateColorForThread(seed) {
  // Simple hash function for string to number
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  
  // Use hash to generate RGB values
  // Ensure we get decent contrast and avoid too dark colors
  const r = Math.abs(hash) % 156 + 50;
  const g = Math.abs(hash >> 8) % 156 + 50;
  const b = Math.abs(hash >> 16) % 156 + 50;
  
  return [r, g, b];
}

class ActiveConnection {
  id = null;
  timestamps = null; // { min, max, current } - original data timestamps
  
  // Scroll/zoom state - independent of backend data
  currentView = { start: 0, end: 100000 }; // Current view window (scrolled/zoomed)
  
  // Auto-request throttling
  isRequestingEvents = false;
  pendingRequest = null;
  
  // Auto-scrolling state
  isScrollingEnabled = true;
  isLocked = true;
  
  // Connection status
  isOnline = true;
  
  // Per-thread data storage
  threadStore = null;

  constructor(id) {
    this.id = id;
    this.threadStore = new ConnectionThreadStore(id);
    makeAutoObservable(this);
  }

  // Update timestamp information
  setTimestamps = action((timestamps) => {
    const isFirstTime = !this.timestamps;
    const previousMax = this.timestamps?.max;
    
    this.timestamps = {
      min: timestamps.min,
      max: timestamps.max,
      current: timestamps.current
    };
    
    // Reset view on first timestamps received
    if (isFirstTime) {
      this.resetViewToData();
    } 
    // Check if max timestamp increased
    else if (previousMax && timestamps.max > previousMax) {
      // If scrolling is enabled, automatically move the end to the new max
      if (this.isScrollingEnabled) {
        this.currentView.end = timestamps.max;
        console.log(`Auto-scrolling: moved end to ${timestamps.max}`);
        this.scheduleEventRequest();
      }
      // If scrolling is disabled but new data is in display range, still request
      else if (previousMax < this.currentView.end) {
        console.log(`Max timestamp increased from ${previousMax} to ${timestamps.max}, triggering auto-request since ${previousMax} < ${this.currentView.end}`);
        this.scheduleEventRequest();
      }
    }
  })

  // External actions
  resetViewToData() {
    if (!this.timestamps) return;
    
    const range = this.timestamps.max - this.timestamps.min;
    const minRange = 1000000000; // 1 second in nanoseconds
    
    if (range < minRange) {
      // If range is too small, show 1 second from start
      this.currentView = {
        start: this.timestamps.min,
        end: this.timestamps.min + minRange
      };
    } else {
      // Use full range
      this.currentView = {
        start: this.timestamps.min,
        end: this.timestamps.max
      };
    }

    // Force immediate request since this is initial setup
    this.executeEventRequest();
  }

  // Events requests
  scheduleEventRequest() {
    if (this.isRequestingEvents) {
      // Save the current view as pending request
      this.pendingRequest = {
        start: this.currentView.start,
        end: this.currentView.end
      };
      return;
    }

    // Execute request immediately
    this.executeEventRequest();
  }
  executeEventRequest() {
    if (this.isRequestingEvents) return;

    this.isRequestingEvents = true;
    this.pendingRequest = null;

    // Notify parent to make the request
    if (this.onRequestEvents) {
      this.onRequestEvents(this.id, this.currentView.start, this.currentView.end + 1);
    }
  }
  onEventRequestComplete() {
    this.isRequestingEvents = false;
    
    // If there's a pending request, execute it
    if (this.pendingRequest) {
      this.currentView.start = this.pendingRequest.start;
      this.currentView.end = this.pendingRequest.end;
      this.executeEventRequest();
    }
  }
  onEventRequestError() {
    // Reset requesting state on error so we can try again
    this.isRequestingEvents = false;
    
    // Don't execute pending request immediately, let user trigger it
  }

  // Per-thread canvas management
  setCanvasRef(thread_ord_id, canvas) {
    this.threadStore.setThreadCanvasRef(thread_ord_id, canvas);
    if (canvas) {
    }
  }
  removeCanvasRef(thread_ord_id) {
    this.threadStore.removeThreadCanvasRef(thread_ord_id);
    console.log(`Canvas reference removed for connection ${this.id}, thread ${thread_ord_id}`);
  }
  // Container event setup (will be called from React component)
  setupContainerEvents(container) {
    if (!container) return;

    container.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const mouseX = (e.clientX - rect.left) / rect.width;
        this.handleZoom(e.deltaY, mouseX);
      } else if (e.shiftKey) {
        e.preventDefault();
        this.handleHorizontalScroll(e.deltaY);
      }
    });
  }



  // Start/End line utilities
  getStartEndLinePositions(canvasWidthPx) {
    if (!this.timestamps) return { startVisible: false, endVisible: false };
    
    const viewRange = this.currentView.end - this.currentView.start;
    const startPos = this.timestamps.min;
    const endPos = this.timestamps.max;
    
    // Check if positions are within current view
    const startVisible = startPos >= this.currentView.start && startPos <= this.currentView.end;
    const endVisible = endPos >= this.currentView.start && endPos <= this.currentView.end;
    
    // Calculate pixel positions (0 to canvasWidthPx)
    const startPixel = startVisible ? ((startPos - this.currentView.start) / viewRange) * canvasWidthPx : 0;
    const endPixel = endVisible ? ((endPos - this.currentView.start) / viewRange) * canvasWidthPx : 0;
    
    return {
      startVisible,
      endVisible,
      startPixel: Math.round(startPixel),
      endPixel: Math.round(endPixel),
      startTimestamp: startPos,
      endTimestamp: endPos
    };
  }

  // Zoom indicator utilities
  getOptimalTimeUnit(canvasWidthPx) {
    if (!this.timestamps) return null;
    
    const currentRangeNs = this.currentView.end - this.currentView.start;
    const targetPixelWidth = 200;
    
    // Calculate nanoseconds per pixel
    const nsPerPixel = currentRangeNs / canvasWidthPx;
    
    // Target nanoseconds for ~200px segment
    const targetNs = nsPerPixel * targetPixelWidth;
    
    // Define unit options in nanoseconds
    const unitOptions = [
      // Nanoseconds
      { value: 10, unit: 'ns', label: '10ns' },
      { value: 20, unit: 'ns', label: '20ns' },
      { value: 50, unit: 'ns', label: '50ns' },
      { value: 100, unit: 'ns', label: '100ns' },
      { value: 200, unit: 'ns', label: '200ns' },
      { value: 500, unit: 'ns', label: '500ns' },
      // Microseconds
      { value: 1000, unit: 'μs', label: '1μs' },
      { value: 2000, unit: 'μs', label: '2μs' },
      { value: 5000, unit: 'μs', label: '5μs' },
      { value: 10000, unit: 'μs', label: '10μs' },
      { value: 20000, unit: 'μs', label: '20μs' },
      { value: 50000, unit: 'μs', label: '50μs' },
      { value: 100000, unit: 'μs', label: '100μs' },
      { value: 200000, unit: 'μs', label: '200μs' },
      { value: 500000, unit: 'μs', label: '500μs' },
      // Milliseconds
      { value: 1000000, unit: 'ms', label: '1ms' },
      { value: 2000000, unit: 'ms', label: '2ms' },
      { value: 5000000, unit: 'ms', label: '5ms' },
      { value: 10000000, unit: 'ms', label: '10ms' },
      { value: 20000000, unit: 'ms', label: '20ms' },
      { value: 50000000, unit: 'ms', label: '50ms' },
      { value: 100000000, unit: 'ms', label: '100ms' },
      { value: 200000000, unit: 'ms', label: '200ms' },
      { value: 500000000, unit: 'ms', label: '500ms' },
      // Seconds
      { value: 1000000000, unit: 's', label: '1s' },
      { value: 2000000000, unit: 's', label: '2s' },
      { value: 5000000000, unit: 's', label: '5s' },
      { value: 10000000000, unit: 's', label: '10s' },
      { value: 20000000000, unit: 's', label: '20s' },
      { value: 50000000000, unit: 's', label: '50s' },
      { value: 100000000000, unit: 's', label: '100s' }
    ];
    
    // Find the best fit (closest to target without being too small)
    let bestUnit = unitOptions[0];
    let bestDiff = Math.abs(targetNs - bestUnit.value);
    
    for (const unit of unitOptions) {
      const diff = Math.abs(targetNs - unit.value);
      if (diff < bestDiff || (diff === bestDiff && unit.value > bestUnit.value)) {
        bestUnit = unit;
        bestDiff = diff;
      }
    }
    
    // Calculate actual pixel width for this unit
    const actualPixelWidth = (bestUnit.value / nsPerPixel);
    
    return {
      ...bestUnit,
      pixelWidth: actualPixelWidth,
      nsPerPixel: nsPerPixel,
      currentRangeNs: currentRangeNs
    };
  }

  // Zooming/panning
  handleHorizontalScroll = action((deltaY) => {
    // If scrolling is disabled, allow normal panning
    if (!this.isScrollingEnabled) {
      // Normal panning behavior when scrolling is off
    } else if (this.isLocked) {
      // If scrolling is on and locked, ignore panning completely
      return;
    } else {
      // If scrolling is on but not locked, disable auto-scrolling when user manually pans
      this.isScrollingEnabled = false;
    }
    
    const currentRange = this.currentView.end - this.currentView.start;
    const scrollAmount = currentRange * 0.1 * Math.sign(deltaY);
    
    this.currentView.start += scrollAmount;
    this.currentView.end += scrollAmount;

    // Auto-request events for new view
    this.scheduleEventRequest();
  })
  handleZoom = action((deltaY, mouseX) => {
    const currentRange = this.currentView.end - this.currentView.start;
    const zoomFactor = deltaY > 0 ? 1.15 : 0.85; // Zoom out or in
    const newRange = currentRange * zoomFactor;
    
    // Don't zoom too small
    if (newRange < 1) return;
    
    if (!this.isScrollingEnabled) {
      // When scrolling is off, use normal zoom behavior (ignore lock state)
      // Calculate mouse position in timestamp space
      const mouseTimestamp = this.currentView.start + (this.currentView.end - this.currentView.start) * mouseX;
      
      // Calculate new start/end keeping mouse position fixed
      const leftRatio = (mouseTimestamp - this.currentView.start) / currentRange;
      const rightRatio = (this.currentView.end - mouseTimestamp) / currentRange;
      
      let newStart = mouseTimestamp - newRange * leftRatio;
      let newEnd = mouseTimestamp + newRange * rightRatio;
      
      // Don't allow negative timestamps
      if (newStart < 0) {
        newStart = 0;
        newEnd = newRange;
      }
      
      this.currentView.start = newStart;
      this.currentView.end = newEnd;
    } else if (this.isLocked) {
      // When scrolling is on and locked, adjust start position relative to end
      // Keep the end position fixed and adjust start
      let newStart = this.currentView.end - newRange;
      
      // Don't allow negative timestamps
      if (newStart < 0) {
        newStart = 0;
      }
      
      this.currentView.start = newStart;
      // End stays the same when locked
    } else {
      // When scrolling is on but not locked, disable auto-scrolling and use normal zoom
      this.isScrollingEnabled = false;
      
      // Calculate mouse position in timestamp space
      const mouseTimestamp = this.currentView.start + (this.currentView.end - this.currentView.start) * mouseX;
      
      // Calculate new start/end keeping mouse position fixed
      const leftRatio = (mouseTimestamp - this.currentView.start) / currentRange;
      const rightRatio = (this.currentView.end - mouseTimestamp) / currentRange;
      
      let newStart = mouseTimestamp - newRange * leftRatio;
      let newEnd = mouseTimestamp + newRange * rightRatio;
      
      // Don't allow negative timestamps
      if (newStart < 0) {
        newStart = 0;
        newEnd = newRange;
      }
      
      this.currentView.start = newStart;
      this.currentView.end = newEnd;
    }

    // Auto-request events for new view
    this.scheduleEventRequest();
  })



  handleNewEvents = (thread_ord_id, view, stats) => {
    let s = trace.start();

    // Store skip stats for this thread
    this.threadStore.setThreadSkipStats(thread_ord_id, stats);
    
    let offset = 0;

    // Parse events for canvas rendering
    const instantEvents = [];
    const rangeEvents = [];

    const instantEventsLen = view.getUint32(offset, true);
    offset += 4;
    const instantEventsEnd = offset + instantEventsLen;

    while (offset < instantEventsEnd) {
      const tm = Number(view.getBigUint64(offset, true));
      offset += 8;
      const eventId = view.getUint8(offset);
      offset += 1;

      instantEvents.push({
        timestamp: tm,
        event_id: eventId,
        color_seed: `instant-${thread_ord_id}-${eventId}`
      });
    }

    // Parse Range Events
    while (offset < view.byteLength - 4) {
      const start = Number(view.getBigUint64(offset, true));
      offset += 8;
      const end = Number(view.getBigUint64(offset, true));
      offset += 8;
      const start_id = view.getUint8(offset);
      offset += 1;
      const end_id = view.getUint8(offset);
      offset += 1;

      rangeEvents.push({
        start_timestamp: start,
        end_timestamp: end,
        start_event_id: start_id,
        end_event_id: end_id,
        color_seed: `range-${thread_ord_id}-${start_id}`
      });
    }

    trace.end(s, "parse raw events")

    // Update OpenGL buffers directly
    this.updateCanvasData(thread_ord_id, instantEvents, rangeEvents);

    // Notify connection that request is complete (for throttling)
    this.onEventRequestComplete();
  };


  updateCanvasData(thread_ord_id, instantEvents, rangeEvents) {
    // Update buffers for this specific thread
    this.updateThreadBuffers(thread_ord_id, instantEvents);
  }
  updateThreadBuffers(thread_ord_id, instantEvents) {
    if (!this.timestamps) return;
    let s = trace.start();

    const eventCount = instantEvents.length;

    if (eventCount === 0) {
      // Keep thread but mark as having 0 events (don't delete to avoid race conditions)
      const thread = this.threadStore.getOrCreateThread(thread_ord_id);
      thread.count = 0;
      trace.end(s, "updateThreadBuffers")
      return;
    }

    // Calculate positions (0.0 to 1.0) and generate colors
    const positions = new Float32Array(eventCount);
    const colors = new Float32Array(eventCount * 3); // RGB per instance

    for (let i = 0; i < instantEvents.length; i++) {
      const event = instantEvents[i];
      
      // Normalize timestamp to 0.0-1.0 range based on current view
      const viewRange = this.currentView.end - this.currentView.start;
      positions[i] = viewRange > 0 ? (event.timestamp - this.currentView.start) / viewRange : 0.0;
      
      // Generate color using the existing logic
      const rgb = generateColorForThread(event.color_seed);

      // Convert to 0.0-1.0 range for WebGL
      colors[i * 3] = rgb[0] / 255.0;     // R
      colors[i * 3 + 1] = rgb[1] / 255.0; // G  
      colors[i * 3 + 2] = rgb[2] / 255.0; // B
    }

    // Update buffers for this thread
    this.threadStore.updateThreadBuffers(thread_ord_id, positions, colors, eventCount);
    trace.end(s, "updateThreadBuffers")
  }
  // Getter for thread skip stats
  getThreadSkipStats(thread_ord_id) {
    return this.threadStore.getThreadSkipStats(thread_ord_id);
  }

  // Get all thread skip stats
  getAllThreadSkipStats() {
    return this.threadStore.getAllThreadSkipStats();
  }

  // Get all threads
  getAllThreads() {
    return this.threadStore.getAllThreads();
  }

  // Per-thread canvas management methods (delegate to threadStore)
  setThreadCanvasRef(thread_ord_id, canvas) {
    this.threadStore.setThreadCanvasRef(thread_ord_id, canvas);
  }

  getThreadCanvasRef(thread_ord_id) {
    return this.threadStore.getThreadCanvasRef(thread_ord_id);
  }

  removeThreadCanvasRef(thread_ord_id) {
    this.threadStore.removeThreadCanvasRef(thread_ord_id);
  }
  
  // Thread name management
  setThreadName(thread_ord_id, name) {
    this.threadStore.setThreadName(thread_ord_id, name);
  }
  
  getThreadName(thread_ord_id) {
    return this.threadStore.getThreadName(thread_ord_id);
  }
  
  // Control rendering based on expanded state
  setExpanded(isExpanded) {
    this.threadStore.setAllThreadsExpanded(isExpanded);
  }
  
  // Scrolling control
  toggleScrolling = action(() => {
    this.isScrollingEnabled = !this.isScrollingEnabled;
    
    // When enabling scrolling, immediately jump to max timestamp
    if (this.isScrollingEnabled && this.timestamps) {
      this.currentView.end = this.timestamps.max;
      this.scheduleEventRequest();
    }
  })
  
  setScrolling = action((enabled) => {
    this.isScrollingEnabled = enabled;
    
    // When enabling scrolling, immediately jump to max timestamp
    if (enabled && this.timestamps) {
      this.currentView.end = this.timestamps.max;
      this.scheduleEventRequest();
    }
  })
  
  // Lock control
  toggleLock = action(() => {
    this.isLocked = !this.isLocked;
  })
  
  setLock = action((locked) => {
    this.isLocked = locked;
  })

  cleanup() {
    // Clean up thread store (per-thread cleanup will be handled in ConnectionThread)
    this.threadStore.cleanup();
  }
}

export default ActiveConnection;