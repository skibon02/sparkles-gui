import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import trace from "../../trace.js";

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

  let res = (
    <canvas
      ref={canvasRef}
      className="connection-canvas"
      style={{ '--canvas-height': `${canvasHeight}px` }}
    />
  );

  trace.end(s, "render ThreadCanvas");
  return res;
});

export default ThreadCanvas;