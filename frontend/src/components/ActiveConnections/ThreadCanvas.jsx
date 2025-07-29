import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import trace from "../../trace.js";
import cursorStore from '../../stores/CursorStore.js';

const ThreadCanvas = observer(({ store, connectionId, thread }) => {
  let s = trace.start();
  const canvasRef = useRef(null);

  useEffect(() => {
    if (canvasRef.current) {
      store.setCanvasRef(connectionId, thread.thread_ord_id, canvasRef.current);
    }

    return () => {
      store.removeCanvasRef(connectionId, thread.thread_ord_id);
    };
  }, [store, connectionId, thread.thread_ord_id]);

  const canvasHeight = thread.getCanvasHeight();

  const handleMouseMove = (e) => {
    if (!canvasRef.current) return;
    
    const rect = canvasRef.current.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;
    
    // Update global cursor position (screen coordinates)
    cursorStore.setPosition(e.clientX, e.clientY);
    cursorStore.setActiveCanvas(canvasRef.current, connectionId, thread.thread_ord_id);
    
    // Read pixel color from WebGL and lookup event name
    const connection = store.getConnection(connectionId);
    if (connection) {
      console.log(`🖱️ Mouse move on thread ${thread.thread_ord_id} at (${canvasX}, ${canvasY})`);
      const pixelColor = connection.threadStore.readPixelColor(thread.thread_ord_id, canvasX, canvasY);
      const eventName = connection.threadStore.getEventNameByColor(thread.thread_ord_id, pixelColor.r, pixelColor.g, pixelColor.b);
      console.log(`📋 Setting tooltip: eventName="${eventName}"`);
      cursorStore.setPixelColor(pixelColor.r, pixelColor.g, pixelColor.b, pixelColor.a, eventName);
    }
  };

  const handleMouseEnter = () => {
    cursorStore.show();
  };

  const handleMouseLeave = () => {
    cursorStore.hide();
  };

  let res = (
    <canvas
      ref={canvasRef}
      className="connection-canvas"
      style={{ '--canvas-height': `${canvasHeight}px` }}
      onMouseMove={handleMouseMove}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    />
  );

  trace.end(s, "render ThreadCanvas");
  return res;
});

export default ThreadCanvas;