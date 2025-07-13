import { makeAutoObservable } from 'mobx';

// Color cache for performance
const colorCache = new Map();

// Utility functions for color generation
const generateColorForThread = async (str) => {
  // Check cache first
  if (colorCache.has(str)) {
    return colorCache.get(str);
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const hue = parseInt(hashHex.substring(0, 4), 16) % 360;
  const saturation = 80 + (parseInt(hashHex.substring(4, 6), 16) % 20);
  const value = 30 + parseInt(hashHex.substring(6, 8), 16) % 20;

  const rgb = hsvToRgb(hue, saturation, value);
  const hex = `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`;

  const result = { hsv: [hue, saturation, value], rgb, hex };
  
  // Cache the result
  colorCache.set(str, result);
  
  return result;
};

const hsvToRgb = (h, s, v) => {
  h /= 360; s /= 100; v /= 100;
  let r, g, b;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
};

class ActiveConnection {
  id = null;
  timestamps = null; // { min, max, current } - original data timestamps
  canvasRef = null;
  gl = null;
  shaderProgram = null;
  
  // Rendering state
  isRendering = false;
  animationFrameId = null;
  needsRedraw = false;
  
  // Scroll/zoom state - independent of backend data
  currentView = { start: 0, end: 100000 }; // Current view window (scrolled/zoomed)
  
  // Auto-request throttling
  isRequestingEvents = false;
  pendingRequest = null;
  
  // Resize handling
  resizeObserver = null;
  
  // WebGL buffers and uniforms
  triangleVertexBuffer = null;
  
  // Per-thread data storage: Map<thread_ord_id, {positions, colors, count}>
  threadBuffers = new Map();

  constructor(id) {
    this.id = id;
    makeAutoObservable(this);
  }

  setTimestamps(timestamps) {
    const isFirstTime = !this.timestamps;
    
    this.timestamps = {
      min: timestamps.min,
      max: timestamps.max,
      current: timestamps.current
    };
    
    // Reset view on first timestamps received
    if (isFirstTime) {
      this.resetViewToData();
      console.log(`First timestamps received for connection ${this.id}, view reset and requesting events`);
    }
  }

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
      console.log(`View reset to 1s range: ${this.timestamps.min} - ${this.timestamps.min + minRange}`);
    } else {
      // Use full range
      this.currentView = {
        start: this.timestamps.min,
        end: this.timestamps.max
      };
      console.log(`View reset to full range: ${this.timestamps.min} - ${this.timestamps.max}`);
    }
    
    this.needsRedraw = true;
    
    // Force immediate request since this is initial setup
    this.executeEventRequest();
  }

  resetView() {
    if (this.timestamps) {
      this.currentView = {
        start: this.timestamps.min,
        end: this.timestamps.max
      };
      this.needsRedraw = true;
      
      // Auto-request events for reset view
      this.scheduleEventRequest();
    }
  }

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
      this.onRequestEvents(this.id, this.currentView.start, this.currentView.end);
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
    console.log(`Event request failed for connection ${this.id}, throttling reset`);
  }

  setCanvasRef(canvas) {
    this.canvasRef = canvas;
    if (canvas) {
      this.initWebGL();
      this.setupCanvasEvents();
      this.setupResizeObserver();
      console.log(`Canvas reference set for connection ${this.id}, ready for WebGL rendering`);
    }
  }

  setupResizeObserver() {
    if (!this.canvasRef) return;

    // Update canvas size to match element size
    this.updateCanvasSize();

    // Watch for size changes
    this.resizeObserver = new ResizeObserver(() => {
      this.updateCanvasSize();
    });
    
    this.resizeObserver.observe(this.canvasRef);
  }

  updateCanvasSize() {
    if (!this.canvasRef || !this.gl) return;

    const rect = this.canvasRef.getBoundingClientRect();
    const displayWidth = rect.width;
    const displayHeight = rect.height;

    // Set canvas buffer size to match display size
    if (this.canvasRef.width !== displayWidth || this.canvasRef.height !== displayHeight) {
      this.canvasRef.width = displayWidth;
      this.canvasRef.height = displayHeight;

      // Update WebGL viewport
      this.gl.viewport(0, 0, displayWidth, displayHeight);

      // Update canvas size uniform
      if (this.shaderProgram) {
        this.gl.useProgram(this.shaderProgram);
        const canvasSizeLocation = this.gl.getUniformLocation(this.shaderProgram, 'u_canvasSize');
        this.gl.uniform2f(canvasSizeLocation, displayWidth, displayHeight);
      }

      this.needsRedraw = true;
      console.log(`Canvas resized for connection ${this.id}: ${displayWidth}x${displayHeight}`);
    }
  }

  setupCanvasEvents() {
    if (!this.canvasRef) return;

    this.canvasRef.addEventListener('wheel', (e) => {
      e.preventDefault();
      
      if (e.shiftKey) {
        // Horizontal scrolling
        this.handleHorizontalScroll(e.deltaY);
      } else if (e.ctrlKey || e.metaKey) {
        // Zooming with mouse position as anchor
        // Use actual canvas width, not CSS width
        const rect = this.canvasRef.getBoundingClientRect();
        const mouseX = (e.clientX - rect.left) / rect.width;
        this.handleZoom(e.deltaY, mouseX);
      }
    });
  }

  handleHorizontalScroll(deltaY) {
    const currentRange = this.currentView.end - this.currentView.start;
    const scrollAmount = currentRange * 0.1 * Math.sign(deltaY);
    
    this.currentView.start += scrollAmount;
    this.currentView.end += scrollAmount;
    this.needsRedraw = true;
    
    // Auto-request events for new view
    this.scheduleEventRequest();
  }

  handleZoom(deltaY, mouseX) {
    const currentRange = this.currentView.end - this.currentView.start;
    const zoomFactor = deltaY > 0 ? 1.2 : 0.8; // Zoom out or in
    const newRange = currentRange * zoomFactor;
    
    // Don't zoom too small
    if (newRange < 1) return;
    
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
    this.needsRedraw = true;
    
    // Auto-request events for new view
    this.scheduleEventRequest();
  }

  removeCanvasRef() {
    // Clean up resize observer
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    
    this.cleanup();
    this.canvasRef = null;
    console.log(`Canvas reference removed for connection ${this.id}`);
  }

  initWebGL() {
    if (!this.canvasRef) return;

    this.gl = this.canvasRef.getContext('webgl2') || this.canvasRef.getContext('webgl');
    if (!this.gl) {
      console.error(`WebGL not supported for connection ${this.id}`);
      return;
    }

    // Basic WebGL setup (size will be set by updateCanvasSize)
    this.gl.clearColor(0.1, 0.1, 0.1, 1.0);
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

    this.initShaders();
  }

  initShaders() {
    if (!this.gl) return;

    // Vertex shader for instanced triangle rendering
    const vertexShaderSource = `
      attribute vec2 a_vertex; // Triangle vertex position
      attribute float a_instancePosition; // 0.0 to 1.0 position along timeline
      attribute vec3 a_instanceColor; // RGB color for this instance
      
      uniform vec2 u_canvasSize;
      uniform vec2 u_triangleSize;
      uniform float u_threadYOffset; // Y position for this thread
      
      varying vec3 v_color;

      void main() {
        // Scale vertex by triangle size
        vec2 vertex = a_vertex * u_triangleSize;
        
        // Position along timeline (a_instancePosition is 0.0 to 1.0)
        float xPos = a_instancePosition * u_canvasSize.x;
        
        // Use thread-specific Y offset
        float yPos = u_threadYOffset;
        
        // Final position
        vec2 finalPos = vec2(xPos, yPos) + vertex;
        
        // Convert to clip space
        vec2 clipSpace = (finalPos / u_canvasSize) * 2.0 - 1.0;
        clipSpace.y = -clipSpace.y; // Flip Y for screen coordinates
        
        gl_Position = vec4(clipSpace, 0.0, 1.0);
        
        // Pass through the color
        v_color = a_instanceColor;
      }
    `;

    // Fragment shader
    const fragmentShaderSource = `
      precision mediump float;
      varying vec3 v_color;

      void main() {
        gl_FragColor = vec4(v_color, 0.9);
      }
    `;

    const vertexShader = this.compileShader(vertexShaderSource, this.gl.VERTEX_SHADER);
    const fragmentShader = this.compileShader(fragmentShaderSource, this.gl.FRAGMENT_SHADER);

    if (!vertexShader || !fragmentShader) return;

    this.shaderProgram = this.gl.createProgram();
    this.gl.attachShader(this.shaderProgram, vertexShader);
    this.gl.attachShader(this.shaderProgram, fragmentShader);
    this.gl.linkProgram(this.shaderProgram);

    if (!this.gl.getProgramParameter(this.shaderProgram, this.gl.LINK_STATUS)) {
      console.error(`Shader program linking failed for connection ${this.id}:`, 
        this.gl.getProgramInfoLog(this.shaderProgram));
      return;
    }

    this.gl.useProgram(this.shaderProgram);
    
    // Set up buffers and uniforms
    this.initBuffers();
    this.initUniforms();
    
    console.log(`WebGL initialized for connection ${this.id}`);
    
    // Start continuous rendering
    this.startRendering();
  }

  compileShader(source, type) {
    const shader = this.gl.createShader(type);
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      console.error(`Shader compilation failed for connection ${this.id}:`, 
        this.gl.getShaderInfoLog(shader));
      this.gl.deleteShader(shader);
      return null;
    }

    return shader;
  }

  startRendering() {
    if (this.isRendering) return;
    
    this.isRendering = true;
    this.needsRedraw = true;
    
    const renderLoop = () => {
      if (!this.isRendering || !this.gl) return;
      
      this.render();
      this.animationFrameId = requestAnimationFrame(renderLoop);
    };
    
    renderLoop();
    console.log(`Started continuous rendering for connection ${this.id}`);
  }

  stopRendering() {
    this.isRendering = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    console.log(`Stopped rendering for connection ${this.id}`);
  }

  render() {
    if (!this.gl || !this.shaderProgram) return;

    // Time-based clear color animation
    // const time = performance.now() * 0.001; // Convert to seconds

    const r = 0.45;
    const g = 0.4;
    const b = 0.8;

    this.gl.clearColor(r, g, b, 1.0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    
    // Render instant events as triangles for all threads
    this.renderAllThreads();
    
    // Always redraw for continuous animation
    this.needsRedraw = true;
  }

  initBuffers() {
    if (!this.gl) return;
    
    // Create triangle vertex buffer with actual vertices
    this.triangleVertexBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.triangleVertexBuffer);
    
    // Triangle vertices for upward-pointing triangle with cut tail
    const vertices = new Float32Array([
      0.0, -0.5,   // Top point (tip pointing up)
      -0.5, 0.5,   // Bottom left
      -0.2, 0.5,   // Cut left
      
      0.0, -0.5,   // Top point  
      -0.2, 0.5,   // Cut left
      0.2, 0.5,    // Cut right
      
      0.0, -0.5,   // Top point
      0.2, 0.5,    // Cut right
      0.5, 0.5     // Bottom right
    ]);
    
    this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STATIC_DRAW);
  }

  initUniforms() {
    if (!this.gl || !this.shaderProgram) return;

    // Canvas size will be set by updateCanvasSize()

    // Set triangle size uniform
    const triangleSizeLocation = this.gl.getUniformLocation(this.shaderProgram, 'u_triangleSize');
    this.gl.uniform2f(triangleSizeLocation, 16.0, 20.0); // 16px wide, 20px tall
  }

  async updateCanvasData(thread_ord_id, instantEvents, rangeEvents) {
    if (!this.gl || !this.shaderProgram) {
      console.log(`WebGL not ready for connection ${this.id}`);
      return;
    }

    console.log(`Canvas data updated for connection ${this.id}, thread ${thread_ord_id}`, {
      instantEvents: instantEvents.length,
      rangeEvents: rangeEvents.length
    });

    // Update buffers for this specific thread
    await this.updateThreadBuffers(thread_ord_id, instantEvents);
    
    // Mark that we need to redraw
    this.needsRedraw = true;
  }

  async updateThreadBuffers(thread_ord_id, instantEvents) {
    if (!this.gl || !this.timestamps) return;

    const eventCount = instantEvents.length;
    
    if (eventCount === 0) {
      // Keep thread but mark as having 0 events (don't delete to avoid race conditions)
      let threadData = this.threadBuffers.get(thread_ord_id);
      if (!threadData) {
        threadData = makeAutoObservable({
          positionBuffer: this.gl.createBuffer(),
          colorBuffer: this.gl.createBuffer(),
          count: 0
        });
        this.threadBuffers.set(thread_ord_id, threadData);
      }
      threadData.count = 0;
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
      const colorResult = await generateColorForThread(event.color_seed);
      const rgb = colorResult.rgb;
      
      // Convert to 0.0-1.0 range for WebGL
      colors[i * 3] = rgb[0] / 255.0;     // R
      colors[i * 3 + 1] = rgb[1] / 255.0; // G  
      colors[i * 3 + 2] = rgb[2] / 255.0; // B
    }

    // Create or update buffers for this thread
    let threadData = this.threadBuffers.get(thread_ord_id);
    if (!threadData) {
      threadData = makeAutoObservable({
        positionBuffer: this.gl.createBuffer(),
        colorBuffer: this.gl.createBuffer(),
        count: 0
      });
      this.threadBuffers.set(thread_ord_id, threadData);
    }

    // Update position buffer
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, threadData.positionBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, positions, this.gl.DYNAMIC_DRAW);

    // Update color buffer  
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, threadData.colorBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, colors, this.gl.DYNAMIC_DRAW);
    
    threadData.count = eventCount;
  }

  renderAllThreads() {
    if (!this.gl || !this.shaderProgram || this.threadBuffers.size === 0) return;

    this.gl.useProgram(this.shaderProgram);

    // Ensure canvas size uniform is up to date each frame
    const canvasSizeLocation = this.gl.getUniformLocation(this.shaderProgram, 'u_canvasSize');
    this.gl.uniform2f(canvasSizeLocation, this.canvasRef.width, this.canvasRef.height);

    // Get attribute locations
    const vertexLocation = this.gl.getAttribLocation(this.shaderProgram, 'a_vertex');
    const positionLocation = this.gl.getAttribLocation(this.shaderProgram, 'a_instancePosition');
    const colorLocation = this.gl.getAttribLocation(this.shaderProgram, 'a_instanceColor');
    const threadYOffsetLocation = this.gl.getUniformLocation(this.shaderProgram, 'u_threadYOffset');

    // Set up vertex attribute (triangle shape) - same for all threads
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.triangleVertexBuffer);
    this.gl.enableVertexAttribArray(vertexLocation);
    this.gl.vertexAttribPointer(vertexLocation, 2, this.gl.FLOAT, false, 0, 0);

    // Configure instancing for vertex attribute
    if (this.gl.vertexAttribDivisor) {
      this.gl.vertexAttribDivisor(vertexLocation, 0); // Per vertex
    }

    const canvasHeight = this.canvasRef.height;
    const threadHeight = canvasHeight / (this.threadBuffers.size || 1);
    let threadIndex = 0;

    // Render each thread at different Y positions
    for (const [thread_ord_id, threadData] of this.threadBuffers) {
      if (threadData.count === 0) continue;

      // Calculate Y position for this thread
      const yOffset = threadIndex * threadHeight + threadHeight * 0.5;
      this.gl.uniform1f(threadYOffsetLocation, yOffset);

      // Set up instance position attribute for this thread
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, threadData.positionBuffer);
      this.gl.enableVertexAttribArray(positionLocation);
      this.gl.vertexAttribPointer(positionLocation, 1, this.gl.FLOAT, false, 0, 0);
      
      // Set up instance color attribute for this thread
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, threadData.colorBuffer);
      this.gl.enableVertexAttribArray(colorLocation);
      this.gl.vertexAttribPointer(colorLocation, 3, this.gl.FLOAT, false, 0, 0);

      // Configure instancing for instance attributes
      if (this.gl.vertexAttribDivisor) {
        this.gl.vertexAttribDivisor(positionLocation, 1); // Advance per instance
        this.gl.vertexAttribDivisor(colorLocation, 1); // Advance per instance
      }

      // Draw instances for this thread
      if (this.gl.drawArraysInstanced) {
        this.gl.drawArraysInstanced(this.gl.TRIANGLES, 0, 9, threadData.count);
      } else {
        console.warn('Instanced rendering not supported');
      }

      threadIndex++;
    }

    // Clean up
    this.gl.disableVertexAttribArray(vertexLocation);
    this.gl.disableVertexAttribArray(positionLocation);
    this.gl.disableVertexAttribArray(colorLocation);
  }

  cleanup() {
    // Stop rendering loop
    this.stopRendering();
    
    // Clean up WebGL resources
    if (this.gl) {
      // Clean up thread buffers
      for (const threadData of this.threadBuffers.values()) {
        if (threadData.positionBuffer) this.gl.deleteBuffer(threadData.positionBuffer);
        if (threadData.colorBuffer) this.gl.deleteBuffer(threadData.colorBuffer);
      }
      this.threadBuffers.clear();
      
      if (this.triangleVertexBuffer) this.gl.deleteBuffer(this.triangleVertexBuffer);
      if (this.shaderProgram) this.gl.deleteProgram(this.shaderProgram);
    }
    
    this.triangleVertexBuffer = null;
    this.shaderProgram = null;
    this.gl = null;
  }
}

export default ActiveConnection;