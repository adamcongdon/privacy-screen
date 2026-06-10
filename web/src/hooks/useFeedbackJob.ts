import { useEffect, useRef } from 'react';
import { useStore, type JobStatus, type FeedbackJobState } from '../store';

/**
 * Polls the active feedback job (if any) and updates store state.
 * Side-effect hook; returns void.
 */
export function useFeedbackJob(): void {
  const active = useStore((s) => s.activeFeedbackJob);
  const setFeedbackJobState = useStore((s) => s.setFeedbackJobState);
  const clearFeedbackJob = useStore((s) => s.clearFeedbackJob);
  const pushToast = useStore((s) => s.pushToast);

  const toastedRef = useRef<string | null>(null);

  useEffect(() => {
    const jobId = active?.jobId ?? null;
    if (!jobId) {
      // Reset toasted marker so a future job can toast again.
      toastedRef.current = null;
      return;
    }

    let cancelled = false;
    let intervalId: number | null = null;

    const tick = async (): Promise<void> => {
      try {
        const res = await fetch('/api/feedback/' + encodeURIComponent(jobId));
        if (cancelled) return;
        if (res.status === 404) {
          clearFeedbackJob();
          pushToast('error', 'feedback session expired — please resubmit');
          if (intervalId !== null) window.clearInterval(intervalId);
          return;
        }
        if (!res.ok) {
          // Transient server error; warn and keep polling.
          console.warn('feedback job poll failed: HTTP', res.status);
          return;
        }
        const j = await res.json();
        if (cancelled) return;
        // Validate minimal shape
        if (!j || typeof j !== 'object' || typeof j.jobId !== 'string' || typeof j.status !== 'string') {
          console.warn('feedback job poll: unexpected shape', j);
          return;
        }
        const state: FeedbackJobState = {
          jobId: String(j.jobId),
          status: j.status as JobStatus,
          issueNumber: typeof j.issueNumber === 'number' ? j.issueNumber : undefined,
          issueUrl: typeof j.issueUrl === 'string' ? j.issueUrl : undefined,
          error: typeof j.error === 'string' ? j.error : undefined,
        };
        setFeedbackJobState(state);

        if (state.status === 'done' || state.status === 'error') {
          // Terminal state — toast once and stop polling for this job.
          if (toastedRef.current !== jobId) {
            if (state.status === 'done') {
              pushToast('success', 'Filed as #' + (state.issueNumber ?? ''));
            } else {
              pushToast('error', 'Feedback failed: ' + (state.error ?? 'unknown'));
            }
            toastedRef.current = jobId;
          }
          if (intervalId !== null) window.clearInterval(intervalId);
        }
      } catch (err) {
        // Network or parsing error — transient, keep polling.
        console.warn('feedback job poll error:', err);
      }
    };

    // Start polling every 500ms.
    intervalId = window.setInterval(tick, 500);
    // Run an immediate first tick so UI updates promptly.
    void tick();

    return () => {
      cancelled = true;
      if (intervalId !== null) window.clearInterval(intervalId);
      // Reset toasted marker only if job actually changed/cleared.
      if (toastedRef.current === jobId) {
        toastedRef.current = null;
      }
    };
  }, [active?.jobId, setFeedbackJobState, clearFeedbackJob, pushToast]);
}
