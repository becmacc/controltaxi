import React, { CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

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
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [sliderValue, setSliderValue] = useState(0);
  const [sliderEnabled, setSliderEnabled] = useState(false);

  const updateScrollState = useMemo(() => {
    return () => {
      const node = viewportRef.current;
      if (!node) {
        setCanScrollLeft(false);
        setCanScrollRight(false);
        return;
      }

      const maxLeft = node.scrollWidth - node.clientWidth;
      const epsilon = 2;
      setCanScrollLeft(node.scrollLeft > epsilon);
      setCanScrollRight(maxLeft - node.scrollLeft > epsilon);
      if (maxLeft > epsilon) {
        setSliderEnabled(true);
        setSliderValue(Math.round((node.scrollLeft / maxLeft) * 100));
      } else {
        setSliderEnabled(false);
        setSliderValue(0);
      }
    };
  }, []);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;

    updateScrollState();

    const handleScroll = () => updateScrollState();
    node.addEventListener('scroll', handleScroll, { passive: true });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => updateScrollState());
      resizeObserver.observe(node);
      if (node.firstElementChild instanceof HTMLElement) {
        resizeObserver.observe(node.firstElementChild);
      }
    }

    const timer = window.setTimeout(() => updateScrollState(), 80);

    return () => {
      window.clearTimeout(timer);
      node.removeEventListener('scroll', handleScroll);
      resizeObserver?.disconnect();
    };
  }, [children, updateScrollState]);

  const nudge = (direction: 'left' | 'right') => {
    const node = viewportRef.current;
    if (!node) return;
    node.scrollBy({ left: direction === 'left' ? -scrollStep : scrollStep, behavior: 'smooth' });
  };

  const handleSliderChange = (value: number) => {
    setSliderValue(value);
    const node = viewportRef.current;
    if (!node) return;

    const maxLeft = node.scrollWidth - node.clientWidth;
    if (maxLeft <= 0) return;
    node.scrollTo({ left: (value / 100) * maxLeft, behavior: 'auto' });
  };

  const sliderControl = (
    <input
      type="range"
      min={0}
      max={100}
      step={1}
      value={sliderValue}
      onChange={(event) => handleSliderChange(Number(event.target.value))}
      disabled={!sliderEnabled}
      aria-label="Horizontal scroll slider"
      aria-valuetext={`${sliderValue}% horizontal position`}
      title="Drag to scroll horizontally"
      style={{ ['--slider-value' as '--slider-value']: `${sliderValue}%` }}
      className="horizontal-scroll-slider text-gold-500"
    />
  );

  const viewportStyle: CSSProperties = {
    scrollbarWidth: 'none',
    msOverflowStyle: 'none',
  };

  return (
    <div className={`relative ${className}`}>
      <div className="mb-2 px-1">{sliderControl}</div>

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
        className={`overflow-x-auto scroll-smooth focus:outline-none focus:ring-2 focus:ring-gold-500/40 rounded-[inherit] [::-webkit-scrollbar]:hidden ${viewportClassName}`}
      >
        {children}
      </div>

      {canScrollLeft && (
        <>
          <div className="pointer-events-none absolute left-0 top-0 h-full w-10 bg-gradient-to-r from-white to-transparent dark:from-brand-900 dark:to-transparent" />
          <button
            type="button"
            onClick={() => nudge('left')}
            className="absolute left-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full border border-slate-200 dark:border-brand-800 bg-white/95 dark:bg-brand-900/95 text-slate-500 dark:text-slate-300 inline-flex items-center justify-center shadow"
            aria-label="Scroll left"
            title="Scroll left"
          >
            <ChevronLeft size={14} />
          </button>
        </>
      )}

      {canScrollRight && (
        <>
          <div className="pointer-events-none absolute right-0 top-0 h-full w-10 bg-gradient-to-l from-white to-transparent dark:from-brand-900 dark:to-transparent" />
          <button
            type="button"
            onClick={() => nudge('right')}
            className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full border border-slate-200 dark:border-brand-800 bg-white/95 dark:bg-brand-900/95 text-slate-500 dark:text-slate-300 inline-flex items-center justify-center shadow"
            aria-label="Scroll right"
            title="Scroll right"
          >
            <ChevronRight size={14} />
          </button>
        </>
      )}
    </div>
  );
};
