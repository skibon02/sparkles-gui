import { makeAutoObservable } from 'mobx';

class WebSocketStore {
  socket = null;
  isConnected = false;
  reconnectInterval = 1000; // 1 second
  reconnectTimeout = null;
  
  // Data state
  discoveredClients = [];
  activeConnections = [];
  connectionTimestamps = {};
  
  // Canvas/WebGL event data
  canvasEvents = new Map(); // connectionId -> { instantEvents: [], rangeEvents: [] }
  canvasTimeRange = { start: 0, end: 0 };
  canvasRefs = new Map(); // connectionId -> canvas element

  constructor() {
    makeAutoObservable(this);
    this.connect();
  }

  connect = () => {
    try {
      const wsUrl = import.meta.env.DEV 
        ? `ws://localhost:3000/ws`
        : `ws://${window.location.host}/ws`;
      
      this.socket = new WebSocket(wsUrl);
      
      this.socket.onopen = () => {
        console.log('WebSocket connected');
        this.isConnected = true;
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }
      };

      this.socket.onmessage = (event) => {
        this.handleMessage(event);
      };

      this.socket.onclose = () => {
        console.log('WebSocket disconnected, trying to reconnect...');
        this.isConnected = false;
        this.scheduleReconnect();
      };

      this.socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.socket.close();
      };
    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      this.scheduleReconnect();
    }
  };

  scheduleReconnect = () => {
    if (this.reconnectTimeout) return;
    
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, this.reconnectInterval);
  };

  handleMessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      
      if (msg.DiscoveredClients !== undefined) {
        this.discoveredClients = msg.DiscoveredClients.clients;
      }
      
      if (msg.Connected !== undefined) {
        const { id, addr } = msg.Connected;
        console.log('Connected to client:', id, addr);
      }
      
      if (msg.ConnectError !== undefined) {
        console.error('Connection error:', msg.ConnectError);
        alert('Connection error: ' + msg.ConnectError);
      }
      
      if (msg.ActiveConnections !== undefined) {
        this.activeConnections = msg.ActiveConnections;
      }
      
      if (msg.Addressed !== undefined) {
        const { id, message } = msg.Addressed;
        
        if (message.NewEvents !== undefined) {
          await this.handleNewEvents(id, message.NewEvents);
        }
        
        if (message.ConnectionTimestamps !== undefined) {
          this.connectionTimestamps[id] = {
            min: message.ConnectionTimestamps.min,
            max: message.ConnectionTimestamps.max,
            current: message.ConnectionTimestamps.current
          };
        }
      }
      
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  };

  handleNewEvents = async (connectionId, newEvents) => {
    const { data, thread_ord_id } = newEvents;
    const addr = `client-${connectionId}`;

    const uint8Array = new Uint8Array(data);
    const view = new DataView(uint8Array.buffer);
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
        thread_ord_id,
        event_id: eventId,
        color_seed: `${addr}-${thread_ord_id}-${eventId}`
      });
    }

    // Parse Range Events
    while (offset < data.length) {
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
        thread_ord_id,
        start_event_id: start_id,
        end_event_id: end_id,
        color_seed: `${addr}-${thread_ord_id}-${start_id}`
      });
    }

    // Store events for canvas rendering
    this.canvasEvents.set(connectionId, { instantEvents, rangeEvents });
    this.updateCanvasTimeRange();
    this.updateCanvas(connectionId);
  };

  generateColorForThread = async (str) => {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    const hue = parseInt(hashHex.substring(0, 4), 16) % 360;
    const saturation = 80 + (parseInt(hashHex.substring(4, 6), 16) % 20);
    const value = 30 + parseInt(hashHex.substring(6, 8), 16) % 20;

    const rgb = this.hsvToRgb(hue, saturation, value);
    const hex = `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`;

    return { hsv: [hue, saturation, value], rgb, hex };
  };

  hsvToRgb = (h, s, v) => {
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

  updateCanvasTimeRange = () => {
    let minTime = Infinity;
    let maxTime = -Infinity;

    for (const [connectionId, timestamps] of Object.entries(this.connectionTimestamps)) {
      if (timestamps.min < minTime) minTime = timestamps.min;
      if (timestamps.max > maxTime) maxTime = timestamps.max;
    }

    if (minTime !== Infinity && maxTime !== -Infinity) {
      this.canvasTimeRange = { start: minTime, end: maxTime };
    }
  };

  updateCanvas = (connectionId) => {
    const canvas = this.canvasRefs.get(connectionId);
    if (!canvas) {
      console.log(`No canvas found for connection ${connectionId}`);
      return;
    }

    // Prepare data structure for this specific connection's WebGL buffers
    const webglData = this.prepareWebGLDataForConnection(connectionId);
    
    // Placeholder for WebGL rendering logic
    console.log(`Canvas update triggered for connection ${connectionId}`, {
      eventCount: webglData.totalEvents,
      timeRange: this.canvasTimeRange,
      instantEvents: webglData.instantEvents.length,
      rangeEvents: webglData.rangeEvents.length
    });
  };

  prepareWebGLDataForConnection = (connectionId) => {
    const events = this.canvasEvents.get(connectionId);
    if (!events) {
      return {
        instantEvents: [],
        rangeEvents: [],
        totalEvents: 0,
        timeRange: this.canvasTimeRange
      };
    }

    // Sort events by timestamp for efficient rendering
    const sortedInstantEvents = [...events.instantEvents].sort((a, b) => a.timestamp - b.timestamp);
    const sortedRangeEvents = [...events.rangeEvents].sort((a, b) => a.start_timestamp - b.start_timestamp);

    return {
      instantEvents: sortedInstantEvents,
      rangeEvents: sortedRangeEvents,
      totalEvents: sortedInstantEvents.length + sortedRangeEvents.length,
      timeRange: this.canvasTimeRange
    };
  };

  setCanvasRef = (connectionId, canvas) => {
    this.canvasRefs.set(connectionId, canvas);
    if (canvas) {
      console.log(`Canvas reference set for connection ${connectionId}, ready for WebGL rendering`);
    }
  };

  removeCanvasRef = (connectionId) => {
    this.canvasRefs.delete(connectionId);
    console.log(`Canvas reference removed for connection ${connectionId}`);
  };

  // Actions
  sendMessage = (message) => {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(message);
    } else {
      console.error('WebSocket is not open. Cannot send message:', message);
    }
  };

  connectToClient = (addr) => {
    this.sendMessage(JSON.stringify({ "Connect": { "addr": addr } }));
  };

  requestEvents = (connectionId) => {
    let start = 0;
    let end = 100000;
    
    if (this.connectionTimestamps[connectionId]) {
      start = this.connectionTimestamps[connectionId].min;
      end = this.connectionTimestamps[connectionId].max;
    }
    
    this.sendMessage(JSON.stringify({ 
      "RequestNewRange": {
        "conn_id": connectionId,
        "start": start,
        "end": end
      }
    }));
  };

  // Cleanup
  disconnect = () => {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.isConnected = false;
  };
}

export default WebSocketStore;