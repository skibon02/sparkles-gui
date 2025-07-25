import { makeAutoObservable, action } from 'mobx';

class ConnectionThread {
  thread_ord_id = null;
  connectionId = null;
  thread_name = '';
  
  // Canvas reference
  canvasRef = null;
  
  // WebGL context and resources
  gl = null;
  shaderProgram = null;
  triangleVertexBuffer = null;
  
  // Rendering state
  isRendering = false;
  animationFrameId = null;
  
  // Resize handling
  resizeObserver = null;
  
  // WebGL buffers for instant events (triangles)
  instantPositionBuffer = null;
  instantColorBuffer = null;
  instantYPositionBuffer = null;
  instantCount = 0;
  
  // WebGL buffers for range events (rectangles)
  rangePositionBuffer = null;
  rangeColorBuffer = null;
  rangeYPositionBuffer = null;
  rangeCount = 0;
  
  // Skip statistics
  skipStats = null;
  
  // Track count for dynamic canvas height
  tracksCnt = 1;
  
  // Maximum Y position for height calculation
  maxYPosition = 0;
  
  // Pending buffer data for when WebGL becomes ready
  pendingBufferData = null;

  constructor(thread_ord_id, connectionId) {
    this.thread_ord_id = thread_ord_id;
    this.connectionId = connectionId;
    
    makeAutoObservable(this);
  }

  // Update skip stats for this thread
  setSkipStats(stats) {
    this.skipStats = stats;
  }

  // Get skip stats for this thread
  getSkipStats() {
    return this.skipStats;
  }
  
  // Get computed canvas height based on maximum Y position
  getCanvasHeight() {
    const baseHeight = 30; // Base height for top offset
    const rowHeight = 25; // Height per Y level
    return baseHeight + (this.maxYPosition + 1) * rowHeight;
  }
  
  // Set tracks count
  setTracksCnt(count) {
    this.tracksCnt = count;
  }
  
  // Get tracks count
  getTracksCnt() {
    return this.tracksCnt;
  }
  
  // Thread name methods
  setThreadName(name) {
    this.thread_name = name;
  }
  
  getThreadName() {
    return this.thread_name;
  }
  
  // Rendering control based on expanded state
  setExpanded = action((isExpanded) => {
    if (isExpanded && !this.isRendering && this.gl) {
      this.startRendering();
    } else if (!isExpanded && this.isRendering) {
      this.stopRendering();
    }
  })

  // Canvas management
  setCanvasRef(canvas) {
    this.canvasRef = canvas;
    if (canvas) {
      this.initWebGL();
      this.setupResizeObserver();
    }
  }

  getCanvasRef() {
    return this.canvasRef;
  }

  removeCanvasRef() {
    // Clean up resize observer
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.cleanup();
    this.canvasRef = null;
  }

  // WebGL initialization
  initWebGL() {
    if (!this.canvasRef) return;

    this.gl = this.canvasRef.getContext('webgl2') || this.canvasRef.getContext('webgl');
    if (!this.gl) {
      console.error(`WebGL not supported for thread ${this.thread_ord_id}`);
      return;
    }

    // Basic WebGL setup
    this.gl.clearColor(0.1333, 0.129, 0.196, 1.0);
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

    this.initShaders();
  }

  initShaders() {
    if (!this.gl) return;

    // Vertex shader for both triangles and rectangles
    const vertexShaderSource = `
      attribute vec2 a_vertex; // Shape vertex position
      attribute float a_instancePosition; // 0.0 to 1.0 position along timeline (triangle) or start pos (rectangle)
      attribute vec3 a_instanceColor; // RGB color for this instance
      attribute float a_instanceWidth; // Width for rectangles (unused for triangles)
      attribute float a_instanceYPos; // Y position (0-255)
      
      uniform vec2 u_canvasSize;
      uniform vec2 u_triangleSize;
      uniform float u_pixelRatio;
      uniform float u_rectHeight; // Height for rectangles in CSS pixels
      uniform bool u_isRectMode; // true for rectangles, false for triangles
      uniform float u_rowHeight; // Height per Y level in CSS pixels
      
      varying vec3 v_color;

      void main() {
        // Calculate vertical offset based on Y position
        float yOffset = 15.0 * u_pixelRatio + a_instanceYPos * u_rowHeight * u_pixelRatio;
        
        if (u_isRectMode) {
          // Rectangle rendering
          vec2 vertex = a_vertex; // vertex is already in 0-1 range for rectangle
          
          // Calculate rectangle dimensions
          float rectWidthPx = a_instanceWidth * u_canvasSize.x;
          float rectHeightPx = u_rectHeight * u_pixelRatio;
          
          // Position along timeline
          float xPos = a_instancePosition * u_canvasSize.x + vertex.x * rectWidthPx;
          float yPos = yOffset + vertex.y * rectHeightPx;
          
          vec2 finalPos = vec2(xPos, yPos);
          
          // Convert to clip space
          vec2 clipSpace = (finalPos / u_canvasSize) * 2.0 - 1.0;
          clipSpace.y = -clipSpace.y; // Flip Y for screen coordinates
          
          gl_Position = vec4(clipSpace, 0.0, 1.0);
        } else {
          // Triangle rendering
          vec2 vertex = a_vertex * u_triangleSize * u_pixelRatio;
          
          // Position along timeline
          float xPos = a_instancePosition * u_canvasSize.x;
          float yPos = yOffset + (u_triangleSize.y * u_pixelRatio) * 0.5;
          
          vec2 finalPos = vec2(xPos, yPos) + vertex;
          
          // Convert to clip space
          vec2 clipSpace = (finalPos / u_canvasSize) * 2.0 - 1.0;
          clipSpace.y = -clipSpace.y; // Flip Y for screen coordinates
          
          gl_Position = vec4(clipSpace, 0.0, 1.0);
        }
        
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
      console.error(`Shader program linking failed for thread ${this.thread_ord_id}:`, 
        this.gl.getProgramInfoLog(this.shaderProgram));
      return;
    }

    this.gl.useProgram(this.shaderProgram);
    
    // Set up buffers and uniforms
    this.initBuffers();
    this.initUniforms();
    
    
    // Apply any pending buffer data
    if (this.pendingBufferData) {
      console.log(`Thread ${this.thread_ord_id}: Applying pending buffer data`);
      this.updateBuffers(
        this.pendingBufferData.instantPositions, 
        this.pendingBufferData.instantColors, 
        this.pendingBufferData.instantCount, 
        this.pendingBufferData.rangePositions, 
        this.pendingBufferData.rangeColors, 
        this.pendingBufferData.rangeCount,
        this.pendingBufferData.instantYPositions,
        this.pendingBufferData.rangeYPositions,
        this.pendingBufferData.maxYPosition
      );
    }
    
    // Start continuous rendering
    this.startRendering();
  }

  compileShader(source, type) {
    const shader = this.gl.createShader(type);
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      console.error(`Shader compilation failed for thread ${this.thread_ord_id}:`, 
        this.gl.getShaderInfoLog(shader));
      this.gl.deleteShader(shader);
      return null;
    }

    return shader;
  }

  initBuffers() {
    if (!this.gl) return;
    
    // Create triangle vertex buffer
    this.triangleVertexBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.triangleVertexBuffer);
    
    // Triangle vertices for upward-pointing triangle with cut tail
    const triangleVertices = new Float32Array([
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
    
    this.gl.bufferData(this.gl.ARRAY_BUFFER, triangleVertices, this.gl.STATIC_DRAW);

    // Create rectangle vertex buffer
    this.rectangleVertexBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.rectangleVertexBuffer);
    
    // Rectangle vertices (0-1 normalized coordinates)
    const rectangleVertices = new Float32Array([
      0.0, 0.0,   // Bottom left
      1.0, 0.0,   // Bottom right  
      0.0, 1.0,   // Top left
      
      1.0, 0.0,   // Bottom right
      1.0, 1.0,   // Top right
      0.0, 1.0    // Top left
    ]);
    
    this.gl.bufferData(this.gl.ARRAY_BUFFER, rectangleVertices, this.gl.STATIC_DRAW);

    // Create per-thread instance buffers for instant events
    this.instantPositionBuffer = this.gl.createBuffer();
    this.instantColorBuffer = this.gl.createBuffer();
    this.instantYPositionBuffer = this.gl.createBuffer();
    
    // Create per-thread instance buffers for range events
    this.rangePositionBuffer = this.gl.createBuffer();
    this.rangeColorBuffer = this.gl.createBuffer();
    this.rangeYPositionBuffer = this.gl.createBuffer();
  }

  initUniforms() {
    if (!this.gl || !this.shaderProgram) return;

    // Update canvas size first to get proper dimensions
    this.updateCanvasSize();
    
    // Set pixel ratio uniform
    const pixelRatio = window.devicePixelRatio || 1;
    const pixelRatioLocation = this.gl.getUniformLocation(this.shaderProgram, 'u_pixelRatio');
    this.gl.uniform1f(pixelRatioLocation, pixelRatio);
    
    // Set triangle size uniform - keep in CSS pixels, shader will handle scaling
    const triangleSizeLocation = this.gl.getUniformLocation(this.shaderProgram, 'u_triangleSize');
    this.gl.uniform2f(triangleSizeLocation, 12.0, 15.0); // 15px tall triangles
    
    // Set rectangle height uniform
    const rectHeightLocation = this.gl.getUniformLocation(this.shaderProgram, 'u_rectHeight');
    this.gl.uniform1f(rectHeightLocation, 12.0); // 12px tall rectangles
    
    // Set row height uniform
    const rowHeightLocation = this.gl.getUniformLocation(this.shaderProgram, 'u_rowHeight');
    this.gl.uniform1f(rowHeightLocation, 25.0); // 25px per Y level
  }

  // Update WebGL buffers
  updateBuffers(instantPositions, instantColors, instantCount, rangePositions, rangeColors, rangeCount, instantYPositions, rangeYPositions, maxYPosition) {
    if (!this.gl || !this.instantPositionBuffer || !this.instantColorBuffer || !this.rangePositionBuffer || !this.rangeColorBuffer) {
      // Store data for when WebGL becomes ready
      this.pendingBufferData = { 
        instantPositions, instantColors, instantCount, instantYPositions,
        rangePositions, rangeColors, rangeCount, rangeYPositions, maxYPosition 
      };
      return;
    }

    // Update instant event buffers (triangles)
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instantPositionBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, instantPositions, this.gl.DYNAMIC_DRAW);

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instantColorBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, instantColors, this.gl.DYNAMIC_DRAW);
    
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instantYPositionBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, instantYPositions, this.gl.DYNAMIC_DRAW);
    
    // Update range event buffers (rectangles)
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.rangePositionBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, rangePositions, this.gl.DYNAMIC_DRAW);

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.rangeColorBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, rangeColors, this.gl.DYNAMIC_DRAW);
    
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.rangeYPositionBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, rangeYPositions, this.gl.DYNAMIC_DRAW);
    
    this.instantCount = instantCount;
    this.rangeCount = rangeCount;
    this.maxYPosition = maxYPosition;
    
    // Clear any pending data since we've successfully updated
    this.pendingBufferData = null;
  }

  // Canvas resizing
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
    
    // Account for device pixel ratio for crisp rendering on high-DPI displays
    const pixelRatio = window.devicePixelRatio || 1;
    const bufferWidth = Math.floor(displayWidth * pixelRatio);
    const bufferHeight = Math.floor(displayHeight * pixelRatio);

    // Set canvas buffer size to match display size * pixel ratio
    if (this.canvasRef.width !== bufferWidth || this.canvasRef.height !== bufferHeight) {
      this.canvasRef.width = bufferWidth;
      this.canvasRef.height = bufferHeight;

      // Update WebGL viewport to match buffer size
      this.gl.viewport(0, 0, bufferWidth, bufferHeight);

      // Update canvas size uniform with buffer dimensions
      if (this.shaderProgram) {
        this.gl.useProgram(this.shaderProgram);
        const canvasSizeLocation = this.gl.getUniformLocation(this.shaderProgram, 'u_canvasSize');
        this.gl.uniform2f(canvasSizeLocation, bufferWidth, bufferHeight);
      }

    }
  }

  // Rendering
  startRendering = action(() => {
    if (this.isRendering) return;
    
    this.isRendering = true;

    const renderLoop = () => {
      if (!this.isRendering || !this.gl) return;
      
      this.render();
      this.animationFrameId = requestAnimationFrame(renderLoop);
    };
    
    renderLoop();
  })

  stopRendering = action(() => {
    this.isRendering = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  })

  render() {
    if (!this.gl || !this.shaderProgram) return;

    const r = 0.1333;
    const g = 0.129;
    const b = 0.196;

    this.gl.clearColor(r, g, b, 1.0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    
    // Only render if we have events
    if (this.instantCount === 0 && this.rangeCount === 0) {
      return;
    }

    this.gl.useProgram(this.shaderProgram);

    // Ensure canvas size uniform is up to date each frame
    const canvasSizeLocation = this.gl.getUniformLocation(this.shaderProgram, 'u_canvasSize');
    this.gl.uniform2f(canvasSizeLocation, this.canvasRef.width, this.canvasRef.height);

    // Get attribute locations
    const vertexLocation = this.gl.getAttribLocation(this.shaderProgram, 'a_vertex');
    const positionLocation = this.gl.getAttribLocation(this.shaderProgram, 'a_instancePosition');
    const colorLocation = this.gl.getAttribLocation(this.shaderProgram, 'a_instanceColor');
    const widthLocation = this.gl.getAttribLocation(this.shaderProgram, 'a_instanceWidth');
    const yPosLocation = this.gl.getAttribLocation(this.shaderProgram, 'a_instanceYPos');
    const rectModeLocation = this.gl.getUniformLocation(this.shaderProgram, 'u_isRectMode');

    // Render triangles (instant events)
    if (this.instantCount > 0) {
      this.gl.uniform1i(rectModeLocation, 0); // Triangle mode
      
      // Set up triangle vertex attribute
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.triangleVertexBuffer);
      this.gl.enableVertexAttribArray(vertexLocation);
      this.gl.vertexAttribPointer(vertexLocation, 2, this.gl.FLOAT, false, 0, 0);
      
      // Set up instance position attribute
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instantPositionBuffer);
      this.gl.enableVertexAttribArray(positionLocation);
      this.gl.vertexAttribPointer(positionLocation, 1, this.gl.FLOAT, false, 0, 0);
      
      // Set up instance color attribute
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instantColorBuffer);
      this.gl.enableVertexAttribArray(colorLocation);
      this.gl.vertexAttribPointer(colorLocation, 3, this.gl.FLOAT, false, 0, 0);
      
      // Set up instance Y position attribute
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instantYPositionBuffer);
      this.gl.enableVertexAttribArray(yPosLocation);
      this.gl.vertexAttribPointer(yPosLocation, 1, this.gl.FLOAT, false, 0, 0);
      
      // Disable width attribute for triangles
      this.gl.disableVertexAttribArray(widthLocation);
      this.gl.vertexAttrib1f(widthLocation, 0.0);

      // Configure instancing
      if (this.gl.vertexAttribDivisor) {
        this.gl.vertexAttribDivisor(vertexLocation, 0); // Per vertex
        this.gl.vertexAttribDivisor(positionLocation, 1); // Per instance
        this.gl.vertexAttribDivisor(colorLocation, 1); // Per instance
        this.gl.vertexAttribDivisor(yPosLocation, 1); // Per instance
        this.gl.vertexAttribDivisor(widthLocation, 0); // Not used for triangles
      }

      // Draw triangles
      if (this.gl.drawArraysInstanced) {
        this.gl.drawArraysInstanced(this.gl.TRIANGLES, 0, 9, this.instantCount);
      }
    }

    // Render rectangles (range events)
    if (this.rangeCount > 0) {
      this.gl.uniform1i(rectModeLocation, 1); // Rectangle mode
      
      // Set up rectangle vertex attribute
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.rectangleVertexBuffer);
      this.gl.enableVertexAttribArray(vertexLocation);
      this.gl.vertexAttribPointer(vertexLocation, 2, this.gl.FLOAT, false, 0, 0);
      
      // Set up instance position attribute (start position)
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.rangePositionBuffer);
      this.gl.enableVertexAttribArray(positionLocation);
      this.gl.vertexAttribPointer(positionLocation, 1, this.gl.FLOAT, false, 8, 0); // First float
      
      // Set up instance width attribute
      this.gl.enableVertexAttribArray(widthLocation);
      this.gl.vertexAttribPointer(widthLocation, 1, this.gl.FLOAT, false, 8, 4); // Second float
      
      // Set up instance color attribute
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.rangeColorBuffer);
      this.gl.enableVertexAttribArray(colorLocation);
      this.gl.vertexAttribPointer(colorLocation, 3, this.gl.FLOAT, false, 0, 0);
      
      // Set up instance Y position attribute
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.rangeYPositionBuffer);
      this.gl.enableVertexAttribArray(yPosLocation);
      this.gl.vertexAttribPointer(yPosLocation, 1, this.gl.FLOAT, false, 0, 0);

      // Configure instancing
      if (this.gl.vertexAttribDivisor) {
        this.gl.vertexAttribDivisor(vertexLocation, 0); // Per vertex
        this.gl.vertexAttribDivisor(positionLocation, 1); // Per instance
        this.gl.vertexAttribDivisor(widthLocation, 1); // Per instance
        this.gl.vertexAttribDivisor(colorLocation, 1); // Per instance
        this.gl.vertexAttribDivisor(yPosLocation, 1); // Per instance
      }

      // Draw rectangles
      if (this.gl.drawArraysInstanced) {
        this.gl.drawArraysInstanced(this.gl.TRIANGLES, 0, 6, this.rangeCount);
      }
    }

    // Clean up
    this.gl.disableVertexAttribArray(vertexLocation);
    this.gl.disableVertexAttribArray(positionLocation);
    this.gl.disableVertexAttribArray(colorLocation);
    this.gl.disableVertexAttribArray(widthLocation);
    this.gl.disableVertexAttribArray(yPosLocation);
  }

  // Cleanup WebGL resources
  cleanup() {
    // Stop rendering loop
    this.stopRendering();
    
    // Clean up WebGL resources
    if (this.gl) {
      if (this.instantPositionBuffer) this.gl.deleteBuffer(this.instantPositionBuffer);
      if (this.instantColorBuffer) this.gl.deleteBuffer(this.instantColorBuffer);
      if (this.instantYPositionBuffer) this.gl.deleteBuffer(this.instantYPositionBuffer);
      if (this.rangePositionBuffer) this.gl.deleteBuffer(this.rangePositionBuffer);
      if (this.rangeColorBuffer) this.gl.deleteBuffer(this.rangeColorBuffer);
      if (this.rangeYPositionBuffer) this.gl.deleteBuffer(this.rangeYPositionBuffer);
      if (this.triangleVertexBuffer) this.gl.deleteBuffer(this.triangleVertexBuffer);
      if (this.rectangleVertexBuffer) this.gl.deleteBuffer(this.rectangleVertexBuffer);
      if (this.shaderProgram) this.gl.deleteProgram(this.shaderProgram);
    }
    
    this.instantPositionBuffer = null;
    this.instantColorBuffer = null;
    this.instantYPositionBuffer = null;
    this.rangePositionBuffer = null;
    this.rangeColorBuffer = null;
    this.rangeYPositionBuffer = null;
    this.triangleVertexBuffer = null;
    this.rectangleVertexBuffer = null;
    this.shaderProgram = null;
    this.instantCount = 0;
    this.rangeCount = 0;
    this.maxYPosition = 0;
    this.gl = null;
    this.canvasRef = null;
  }
}

class ConnectionThreadStore {
  // Map<thread_ord_id, ConnectionThread>
  threads = new Map();
  connectionId = null;

  constructor(connectionId) {
    this.connectionId = connectionId;
    makeAutoObservable(this);
  }

  // Get or create thread (similar to WebSocketStore pattern)
  getOrCreateThread(thread_ord_id) {
    if (!this.threads.has(thread_ord_id)) {
      const thread = new ConnectionThread(thread_ord_id, this.connectionId);
      this.threads.set(thread_ord_id, thread);
    }
    return this.threads.get(thread_ord_id);
  }

  // Get existing thread
  getThread(thread_ord_id) {
    return this.threads.get(thread_ord_id);
  }

  // Get all threads
  getAllThreads() {
    return Array.from(this.threads.values());
  }

  // Get thread skip stats
  getThreadSkipStats(thread_ord_id) {
    const thread = this.getThread(thread_ord_id);
    return thread ? thread.getSkipStats() : null;
  }

  // Get all thread skip stats
  getAllThreadSkipStats() {
    const stats = new Map();
    for (const [threadId, thread] of this.threads) {
      const skipStats = thread.getSkipStats();
      if (skipStats) {
        stats.set(threadId, skipStats);
      }
    }
    return stats;
  }

  // Update thread skip stats
  setThreadSkipStats(thread_ord_id, stats) {
    const thread = this.getOrCreateThread(thread_ord_id);
    thread.setSkipStats(stats);
  }

  // Update thread buffers
  updateThreadBuffers(thread_ord_id, instantPositions, instantColors, instantCount, rangePositions, rangeColors, rangeCount, instantYPositions, rangeYPositions, maxYPosition) {
    const thread = this.getOrCreateThread(thread_ord_id);
    thread.updateBuffers(instantPositions, instantColors, instantCount, rangePositions, rangeColors, rangeCount, instantYPositions, rangeYPositions, maxYPosition);
  }
  
  // Thread name management
  setThreadName(thread_ord_id, name) {
    const thread = this.getOrCreateThread(thread_ord_id);
    thread.setThreadName(name);
  }
  
  getThreadName(thread_ord_id) {
    const thread = this.getThread(thread_ord_id);
    return thread ? thread.getThreadName() : '';
  }
  
  // Expanded state management for all threads
  setAllThreadsExpanded(isExpanded) {
    for (const thread of this.threads.values()) {
      thread.setExpanded(isExpanded);
    }
  }

  // Get thread count
  getThreadCount() {
    return this.threads.size;
  }

  // Canvas management methods (similar to WebSocketStore pattern)
  setThreadCanvasRef(thread_ord_id, canvas) {
    const thread = this.getOrCreateThread(thread_ord_id);
    thread.setCanvasRef(canvas);
  }

  getThreadCanvasRef(thread_ord_id) {
    const thread = this.getThread(thread_ord_id);
    return thread ? thread.getCanvasRef() : null;
  }

  removeThreadCanvasRef(thread_ord_id) {
    const thread = this.getThread(thread_ord_id);
    if (thread) {
      thread.removeCanvasRef();
    }
  }

  // Cleanup all threads
  cleanup() {
    for (const thread of this.threads.values()) {
      thread.cleanup();
    }
    this.threads.clear();
  }
}

export { ConnectionThread, ConnectionThreadStore };
export default ConnectionThreadStore;