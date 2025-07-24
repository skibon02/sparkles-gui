import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import trace from "../../trace.js";
import EditableThreadName from './EditableThreadName.jsx';
import ThreadCanvas from './ThreadCanvas.jsx';
import ZoomIndicator from './ZoomIndicator.jsx';
import StartEndLines from './StartEndLines.jsx';

const ThreadsContainer = observer(({ store, connectionId, threads }) => {
  let s = trace.start();
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    if (containerRef.current) {
      const connection = store.getConnection(connectionId);
      if (connection) {
        connection.setupContainerEvents(containerRef.current);
      }
      
      const updateWidth = () => {
        if (containerRef.current) {
          setContainerWidth(containerRef.current.clientWidth);
        }
      };
      
      updateWidth();
      
      const resizeObserver = new ResizeObserver(updateWidth);
      resizeObserver.observe(containerRef.current);
      
      return () => resizeObserver.disconnect();
    }
  }, [store, connectionId]);

  let res = (
    <div className={"threads-cont"} ref={containerRef}>
      <ZoomIndicator store={store} connectionId={connectionId} containerWidth={containerWidth} />
      <StartEndLines store={store} connectionId={connectionId} containerWidth={containerWidth} />
      {threads.map(thread => (
        <div key={thread.thread_ord_id} className={"thread-item"}>
          <div className={"threads-header"}>
            <div className={"thread-joint"}>⚫︎</div>
            <div className={"thread-name"}>
              <EditableThreadName 
                store={store} 
                connectionId={connectionId} 
                thread={thread} 
              />
            </div>
          </div>
          <div className={"threads-body"}>
            <ThreadCanvas
              store={store}
              connectionId={connectionId}
              thread={thread}
            />
          </div>
        </div>
      ))}
    </div>
  );

  trace.end(s, "render ThreadsContainer");
  return res;
});

export default ThreadsContainer;