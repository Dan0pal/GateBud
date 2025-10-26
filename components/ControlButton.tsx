import React from 'react';
import { AppStatus } from '../types';

interface ControlButtonProps {
  status: AppStatus;
  onClick: () => void;
}

const LoadingSpinner = () => (
    <div className="animate-spin rounded-full h-16 w-16 border-b-4 border-white"></div>
);

const ControlButton: React.FC<ControlButtonProps> = ({ status, onClick }) => {
  const isIdle = status === AppStatus.IDLE;
  const isConnecting = status === AppStatus.CONNECTING;
  const isActive = status === AppStatus.ACTIVE;
  const isError = status === AppStatus.ERROR;

  let buttonClasses = "relative rounded-full w-48 h-48 flex items-center justify-center transition-all duration-300 ease-in-out focus:outline-none focus:ring-4 focus:ring-sky-400/50 ring-2 ring-gray-500/50";
  let content = null;

  if (isIdle) {
    buttonClasses += " bg-sky-500 hover:bg-sky-600 text-white";
  } else if (isConnecting) {
    buttonClasses += " bg-slate-700 cursor-not-allowed";
    content = <LoadingSpinner />;
  } else if (isActive) {
    buttonClasses += " bg-red-500 hover:bg-red-600 text-white";
    content = (
      <>
        <div className="absolute inset-0 rounded-full bg-red-500 animate-ping opacity-75"></div>
      </>
    );
  } else if (isError) {
    buttonClasses += " bg-slate-700 cursor-pointer";
  }

  return (
    <button onClick={onClick} className={buttonClasses} disabled={isConnecting}>
      {content}
    </button>
  );
};

export default ControlButton;