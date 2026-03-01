import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface FlowStage {
  id: string;
  label: string;
}

interface OperationalFlowNavigatorProps {
  stages: FlowStage[];
  offsetTop?: number;
  storageKey?: string;
}

const GESTURE_COOLDOWN_MS = 400;

export const OperationalFlowNavigator: React.FC<OperationalFlowNavigatorProps> = ({
  stages,
  offsetTop = 96,
  storageKey,
}) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastGestureAtRef = useRef(0);

  const stageIds = useMemo(() => stages.map(stage => stage.id), [stages]);

  const runGesture = useCallback((direction: 'next' | 'prev') => {
    const now = Date.now();
    if (now - lastGestureAtRef.current < GESTURE_COOLDOWN_MS) return;
    lastGestureAtRef.current = now;

    setActiveIndex(prev => {
      const nextIndex = direction === 'next'
        ? Math.min(stages.length - 1, prev + 1)
        : Math.max(0, prev - 1);

      const target = stages[nextIndex];
      if (target) {
        const element = document.getElementById(target.id);
        if (element) {
          const top = element.getBoundingClientRect().top + window.scrollY - offsetTop;
          window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        }
      }

      return nextIndex;
    });
  }, [offsetTop, stages]);

  const jumpToStage = useCallback((index: number) => {
    if (!stages[index]) return;
    const target = document.getElementById(stages[index].id);
    if (!target) return;

    setActiveIndex(index);
    const top = target.getBoundingClientRect().top + window.scrollY - offsetTop;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [offsetTop, stages]);

  useEffect(() => {
    if (stages.length === 0) return;

    const updateActiveStageFromViewport = () => {
      let resolvedIndex = 0;

      stageIds.forEach((id, index) => {
        const element = document.getElementById(id);
        if (!element) return;
        const topFromMarker = element.getBoundingClientRect().top - offsetTop;
        if (topFromMarker <= 0) {
          resolvedIndex = index;
        }
      });

      setActiveIndex(resolvedIndex);
    };

    updateActiveStageFromViewport();
    window.addEventListener('scroll', updateActiveStageFromViewport, { passive: true });
    window.addEventListener('resize', updateActiveStageFromViewport);

    return () => {
      window.removeEventListener('scroll', updateActiveStageFromViewport);
      window.removeEventListener('resize', updateActiveStageFromViewport);
    };
  }, [offsetTop, stageIds, stages.length]);

  useEffect(() => {
    if (!storageKey || stages.length === 0) return;
    const savedStageId = window.localStorage.getItem(storageKey);
    if (!savedStageId) return;

    const savedIndex = stages.findIndex(stage => stage.id === savedStageId);
    if (savedIndex >= 0) {
      setActiveIndex(savedIndex);
    }
  }, [stages, storageKey]);

  useEffect(() => {
    if (!storageKey || !stages[activeIndex]) return;
    window.localStorage.setItem(storageKey, stages[activeIndex].id);
  }, [activeIndex, stages, storageKey]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        runGesture('next');
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        runGesture('prev');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [runGesture]);

  if (stages.length <= 1) return null;

  return (
    <div
      className="fixed bottom-4 left-1/2 z-[95] w-[min(92vw,680px)] -translate-x-1/2 rounded-2xl border border-slate-200/90 dark:border-brand-800/90 bg-white/95 dark:bg-brand-900/95 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-white/85 md:left-auto md:right-4 md:w-[640px] md:translate-x-0"
      onTouchStart={event => {
        const touch = event.touches[0];
        touchStartRef.current = { x: touch.clientX, y: touch.clientY };
      }}
      onTouchEnd={event => {
        if (!touchStartRef.current) return;
        const touch = event.changedTouches[0];
        const deltaX = touch.clientX - touchStartRef.current.x;
        const deltaY = touch.clientY - touchStartRef.current.y;
        touchStartRef.current = null;

        if (Math.abs(deltaX) < 50 || Math.abs(deltaX) < Math.abs(deltaY)) return;
        runGesture(deltaX < 0 ? 'next' : 'prev');
      }}
      onPointerDown={event => {
        pointerStartRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={event => {
        if (!pointerStartRef.current) return;
        const deltaX = event.clientX - pointerStartRef.current.x;
        const deltaY = event.clientY - pointerStartRef.current.y;
        pointerStartRef.current = null;

        if (Math.abs(deltaX) < 70 || Math.abs(deltaX) < Math.abs(deltaY)) return;
        runGesture(deltaX < 0 ? 'next' : 'prev');
      }}
      onWheel={event => {
        if (Math.abs(event.deltaX) < 35 || Math.abs(event.deltaX) < Math.abs(event.deltaY)) return;
        runGesture(event.deltaX > 0 ? 'next' : 'prev');
      }}
    >
      <div className="flex items-center gap-2 p-2">
        <button
          type="button"
          onClick={() => runGesture('prev')}
          disabled={activeIndex === 0}
          className="h-9 w-9 shrink-0 rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-950 text-slate-600 dark:text-slate-300 inline-flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
          title="Previous stage (Alt+Left)"
          aria-label="Previous stage"
        >
          <ChevronLeft size={15} />
        </button>

        <div className="flex-1 overflow-x-auto">
          <div className="flex items-center gap-1.5 min-w-max pr-1">
            {stages.map((stage, index) => {
              const isActive = index === activeIndex;
              return (
                <button
                  key={stage.id}
                  type="button"
                  onClick={() => jumpToStage(index)}
                  className={`h-9 px-3 rounded-xl border text-[8px] font-black uppercase tracking-[0.2em] whitespace-nowrap transition-colors ${isActive
                    ? 'border-gold-400 bg-gold-500/20 text-gold-700 dark:text-gold-300'
                    : 'border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-950 text-slate-500 dark:text-slate-300 hover:border-slate-300 dark:hover:border-brand-700'}`}
                  title={`Go to ${stage.label}`}
                >
                  {index + 1}. {stage.label}
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={() => runGesture('next')}
          disabled={activeIndex >= stages.length - 1}
          className="h-9 w-9 shrink-0 rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-950 text-slate-600 dark:text-slate-300 inline-flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
          title="Next stage (Alt+Right)"
          aria-label="Next stage"
        >
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
};
