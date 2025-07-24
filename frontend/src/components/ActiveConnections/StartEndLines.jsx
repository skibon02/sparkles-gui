import { observer } from 'mobx-react-lite';

const StartEndLines = observer(({ store, connectionId, containerWidth }) => {
  const connection = store.getConnection(connectionId);
  if (!connection || !containerWidth) return null;
  
  const lineInfo = connection.getStartEndLinePositions(containerWidth);
  
  return (
    <div className="start-end-lines">
      {lineInfo.startVisible && (
        <div 
          className="start-line vertical-line"
          style={{ left: `${lineInfo.startPixel}px` }}
        >
          <div className="line-label">START</div>
        </div>
      )}
      {lineInfo.endVisible && (
        <div 
          className="end-line vertical-line"
          style={{ left: `${lineInfo.endPixel}px` }}
        >
          <div className="line-label">END</div>
        </div>
      )}
    </div>
  );
});

export default StartEndLines;