
import React from 'react';
import { AppStatus } from '../types';

interface StatusIndicatorProps {
  status: AppStatus;
}

const StatusIndicator: React.FC<StatusIndicatorProps> = ({ status }) => {
  let text = '';
  let textColor = 'text-slate-400';

  switch (status) {
    case AppStatus.IDLE:
      text = 'Tap to start conversation';
      break;
    case AppStatus.CONNECTING:
      text = 'Connecting...';
      break;
    case AppStatus.ACTIVE:
      text = 'Listening...';
      textColor = 'text-green-400';
      break;
    case AppStatus.ERROR:
      text = 'An error occurred. Tap to retry.';
      textColor = 'text-red-400';
      break;
    default:
      text = 'Ready';
  }

  return (
    <p className={`mt-8 text-2xl font-medium tracking-wide transition-colors duration-300 ${textColor}`}>
      {text}
    </p>
  );
};

export default StatusIndicator;
