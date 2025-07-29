import { observer } from 'mobx-react-lite';
import cursorStore from '../stores/CursorStore.js';
import './GlobalTooltip.scss';

const GlobalTooltip = observer(() => {
  if (!cursorStore.isVisible || !cursorStore.currentEventName) return null;
  
  // Position tooltip offset from cursor
  const offsetX = 15;
  const offsetY = -30;
  
  return (
    <div 
      className="global-tooltip"
      style={{
        left: cursorStore.screenX + offsetX,
        top: cursorStore.screenY + offsetY,
      }}
    >
      <div className="tooltip-content">
        {cursorStore.currentEventName}
      </div>
    </div>
  );
});

export default GlobalTooltip;