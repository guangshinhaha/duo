import * as RadixToast from "@radix-ui/react-toast";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

/**
 * The toast primitive (#34) — an announcement channel, not a decision
 * surface. Radix supplies the accessibility (each toast is a `status`, the
 * viewport is the live region polite screen readers already know how to
 * read), Escape-when-focused and swipe dismissal; the look is an entry
 * shape from #33. #34's rule for toasts is the same as AR-15's for queues:
 * a toast reports what already happened; it never offers a decision the
 * surface below hasn't already made available.
 */

/** Announce something. One line, already-happened tense; the toast does the rest. */
type PushToast = (message: string) => void;

const ToastContext = createContext<PushToast>(() => {});

/** The hook a surface uses to announce — available wherever the provider is mounted. */
export function useToast(): PushToast {
  return useContext(ToastContext);
}

let nextId = 0;

/**
 * Mount once, near the app root. Holds the queue and the viewport; a toast
 * removes itself when it closes (timeout, Escape-when-focused, or swipe),
 * so nothing here decides lifetimes on the caller's behalf.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; message: string }[]>([]);
  const push = useCallback((message: string) => {
    setToasts((current) => [...current, { id: ++nextId, message }]);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      <RadixToast.Provider swipeDirection="right">
        {children}
        <RadixToast.Viewport className="fixed bottom-4 right-4 z-50 flex flex-col gap-2" data-testid="toast-viewport">
          {toasts.map(({ id, message }) => (
            <RadixToast.Root
              key={id}
              className="shape-entry motion-toast px-4 py-3 type-body text-[var(--text)]"
              duration={5000}
              onOpenChange={(open) => {
                if (!open) {
                  // Radix keeps the toast mounted for its exit animation; the queue entry goes once that has run.
                  setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 400);
                }
              }}
            >
              <RadixToast.Title data-testid="toast">{message}</RadixToast.Title>
            </RadixToast.Root>
          ))}
        </RadixToast.Viewport>
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}
