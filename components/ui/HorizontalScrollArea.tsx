import React, { CSSProperties, useRef } from 'react';

interface HorizontalScrollAreaProps {
  children: React.ReactNode;
  className?: string;
  viewportClassName?: string;
  scrollStep?: number;
}

export const HorizontalScrollArea: React.FC<HorizontalScrollAreaProps> = ({
  children,
  className = '',
  viewportClassName = '',
  scrollStep = 360,
}) => {
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const nudge = (direction: 'left' | 'right') => {
    const node = viewportRef.current;
    if (!node) return;
    node.scrollBy({ left: direction === 'left' ? -scrollStep : scrollStep, behavior: 'smooth' });
  };

  const viewportStyle: CSSProperties = {
    scrollbarWidth: 'none',
    msOverflowStyle: 'none',
  };

  return (
    <div className={`relative ${className}`}>
      <div
        ref={viewportRef}
        tabIndex={0}
        style={viewportStyle}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            nudge('right');
          }
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            nudge('left');
          }
        }}
        className={`relative isolate overflow-x-auto scroll-smooth focus:outline-none focus:ring-2 focus:ring-gold-500/40 rounded-[inherit] [::-webkit-scrollbar]:hidden ${viewportClassName}`}
      >
        {children}
      </div>
    </div>
  );
};
