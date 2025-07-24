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
  
  // WebGL buffers
  positionBuffer = null;
  colorBuffer = null;
  count = 0;
  
  // Skip statistics
  skipStats = null;
  
  // Track count for dynamic canvas height
  tracksCnt = 1;
  
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
  
  // Get computed canvas height based on tracksCnt
  getCanvasHeight() {
    return 20 + this.tracksCnt * 40;
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

    // Vertex shader for instanced triangle rendering
    const vertexShaderSource = `
      attribute vec2 a_vertex; // Triangle vertex position
      attribute float a_instancePosition; // 0.0 to 1.0 position along timeline
      attribute vec3 a_instanceColor; // RGB color for this instance
      
      uniform vec2 u_canvasSize;
      uniform vec2 u_triangleSize;
      
      varying vec3 v_color;

      void main() {
        // Scale vertex by triangle size
        vec2 vertex = a_vertex * u_triangleSize;
        
        // Position along timeline (a_instancePosition is 0.0 to 1.0)
        float xPos = a_instancePosition * u_canvasSize.x;
        
        // Position 10px from top of canvas (triangle tip points up)
        float yPos = 10.0 + u_triangleSize.y * 0.5;
        
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
      console.log(`Thread ${this.thread_ord_id}: Applying pending buffer data with ${this.pendingBufferData.eventCount} events`);
      this.updateBuffers(this.pendingBufferData.positions, this.pendingBufferData.colors, this.pendingBufferData.eventCount);
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

    // Create per-thread instance buffers
    this.positionBuffer = this.gl.createBuffer();
    this.colorBuffer = this.gl.createBuffer();
  }

  initUniforms() {
    if (!this.gl || !this.shaderProgram) return;

    // Set triangle size uniform
    const triangleSizeLocation = this.gl.getUniformLocation(this.shaderProgram, 'u_triangleSize');
    this.gl.uniform2f(triangleSizeLocation, 16.0, 20.0); // 16px wide, 20px tall
    
    // Update canvas size
    this.updateCanvasSize();
  }

  // Update WebGL buffers
  updateBuffers(positions, colors, eventCount) {
    if (!this.gl || !this.positionBuffer || !this.colorBuffer) {
      // Store data for when WebGL becomes ready
      this.pendingBufferData = { positions, colors, eventCount };
      return;
    }


    // Update position buffer
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, positions, this.gl.DYNAMIC_DRAW);

    // Update color buffer  
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.colorBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, colors, this.gl.DYNAMIC_DRAW);
    
    this.count = eventCount;
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
    if (this.count === 0) {
      // Uncomment for debugging: console.log(`Thread ${this.thread_ord_id}: Skipping render - no events (count: ${this.count})`);
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

    // Set up vertex attribute (triangle shape)
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.triangleVertexBuffer);
    this.gl.enableVertexAttribArray(vertexLocation);
    this.gl.vertexAttribPointer(vertexLocation, 2, this.gl.FLOAT, false, 0, 0);

    // Configure instancing for vertex attribute
    if (this.gl.vertexAttribDivisor) {
      this.gl.vertexAttribDivisor(vertexLocation, 0); // Per vertex
    }

    // Set up instance position attribute
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
    this.gl.enableVertexAttribArray(positionLocation);
    this.gl.vertexAttribPointer(positionLocation, 1, this.gl.FLOAT, false, 0, 0);
    
    // Set up instance color attribute
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.colorBuffer);
    this.gl.enableVertexAttribArray(colorLocation);
    this.gl.vertexAttribPointer(colorLocation, 3, this.gl.FLOAT, false, 0, 0);

    // Configure instancing for instance attributes
    if (this.gl.vertexAttribDivisor) {
      this.gl.vertexAttribDivisor(positionLocation, 1); // Advance per instance
      this.gl.vertexAttribDivisor(colorLocation, 1); // Advance per instance
    }

    // Draw instances
    if (this.gl.drawArraysInstanced) {
      this.gl.drawArraysInstanced(this.gl.TRIANGLES, 0, 9, this.count);
    } else {
      console.warn('Instanced rendering not supported');
    }

    // Clean up
    this.gl.disableVertexAttribArray(vertexLocation);
    this.gl.disableVertexAttribArray(positionLocation);
    this.gl.disableVertexAttribArray(colorLocation);
  }

  // Cleanup WebGL resources
  cleanup() {
    // Stop rendering loop
    this.stopRendering();
    
    // Clean up WebGL resources
    if (this.gl) {
      if (this.positionBuffer) this.gl.deleteBuffer(this.positionBuffer);
      if (this.colorBuffer) this.gl.deleteBuffer(this.colorBuffer);
      if (this.triangleVertexBuffer) this.gl.deleteBuffer(this.triangleVertexBuffer);
      if (this.shaderProgram) this.gl.deleteProgram(this.shaderProgram);
    }
    
    this.positionBuffer = null;
    this.colorBuffer = null;
    this.triangleVertexBuffer = null;
    this.shaderProgram = null;
    this.count = 0;
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
  updateThreadBuffers(thread_ord_id, positions, colors, eventCount) {
    const thread = this.getOrCreateThread(thread_ord_id);
    thread.updateBuffers(positions, colors, eventCount);
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