import { makeAutoObservable, action } from 'mobx';

class CursorStore {
  // Cursor position (screen coordinates)
  screenX = 0;
  screenY = 0;
  
  // Current canvas context
  activeCanvas = null;
  activeConnectionId = null;
  activeThreadId = null;
  
  // Color feedback
  pixelColor = { r: 0, g: 0, b: 0, a: 0 };
  currentEventName = null;
  
  // Visibility
  isVisible = false;
  
  constructor() {
    makeAutoObservable(this);
  }
  
  // Set cursor position in screen coordinates
  setPosition = action((screenX, screenY) => {
    this.screenX = screenX;
    this.screenY = screenY;
  })
  
  // Set active canvas context
  setActiveCanvas = action((canvas, connectionId, threadId) => {
    this.activeCanvas = canvas;
    this.activeConnectionId = connectionId;
    this.activeThreadId = threadId;
  })
  
  // Set pixel color and event info from WebGL reading
  setPixelColor = action((r, g, b, a, eventName = null) => {
    this.pixelColor = { r, g, b, a };
    this.currentEventName = eventName;
  })
  
  // Show tooltip
  show = action(() => {
    this.isVisible = true;
  })
  
  // Hide tooltip
  hide = action(() => {
    this.isVisible = false;
    this.activeCanvas = null;
    this.activeConnectionId = null;
    this.activeThreadId = null;
    this.currentEventName = null;
  })
  
}

// Create singleton instance
const cursorStore = new CursorStore();

export default cursorStore;